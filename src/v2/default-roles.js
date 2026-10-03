import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { TECH_LEAD_PLAN_SCHEMA, validateTechLeadPlan } from './tech-lead-plan.js';
import { buildTechLeadPrompt } from './tech-lead-prompt.js';
import { artCapabilityRecommendations, requiredArtCapabilities } from './art-capabilities.js';
import { acceptanceCriterionIds } from './acceptance.js';
import { validatePlanAutonomy } from './autonomy.js';
import { ensureTakeoverReviewState, completeTakeoverReview } from './takeover-gate.js';
import {
  beginFrontierPass,
  finishFrontierPass,
  frontierArtifactInstructions,
  hasBoundaryContracts,
  validateBoundaryContracts,
  validateTaskOwnershipCompilation,
} from './interface-contracts.js';
import { deriveExecutionHandoff } from '../runtime/role-run-prompt.js';
import {
  ensurePlannerArtifactLayout,
  loadFeatureTreeDiff,
  applyFeatureTreeDiff,
  materializeLogicalTree,
  loadPlannerArtifactPlan,
  plannerArtifactInstructions,
  validatePlannerArtifactPlan,
} from './planner-artifacts.js';

function latestRoleResult(task) {
  const history = task?.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.type === 'ROLE_RESULT') return history[i];
  }
  return null;
}

function flowTasks(store, task) {
  return store.listTasks(task.projectId, { flowId: task.flowId });
}

function predecessorResults(store, task) {
  const byId = new Map(flowTasks(store, task).map(item => [item.id, item]));
  return (task.dependsOn ?? []).map(id => latestRoleResult(byId.get(id))).filter(Boolean);
}

function recordArtifactIncidentOnce(store, task, artifactRef, failure) {
  const exists = store.listIncidents(task.projectId).some(
    incident => incident?.type === 'PLANNER_ARTIFACT_INVALID'
      && incident?.artifactRef === artifactRef
      && incident?.failure === failure
  );
  if (exists) return;
  store.recordIncident({
    projectId: task.projectId,
    taskId: task.id,
    type: 'PLANNER_ARTIFACT_INVALID',
    artifactRef,
    failure,
  });
}

function resolveArtifactResult(store, task, result, artifactRoot) {
  if (!result?.artifactRef || !artifactRoot) return result;
  const root = resolve(artifactRoot);
  const file = resolve(root, result.artifactRef);
  if (file !== root && !file.startsWith(root + sep)) {
    const failure = 'artifactRef escapes Ariad artifact root';
    recordArtifactIncidentOnce(store, task, result.artifactRef, failure);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const failure = error?.message ?? String(error);
    recordArtifactIncidentOnce(store, task, result.artifactRef, failure);
    return null;
  }
}

function currentArtifactPlan(artifactRoot) {
  const raw = loadPlannerArtifactPlan(artifactRoot);
  if (!raw) return null;
  return validatePlannerArtifactPlan(raw).plan;
}

function latestLegacyPlanInFlow(store, task, artifactRoot) {
  const tasks = flowTasks(store, task);
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const raw = latestRoleResult(tasks[i])?.result;
    const result = resolveArtifactResult(store, task, raw, artifactRoot);
    const candidate = result?.plan ?? result;
    // Version 3 in task history is a compiled/validated view, not a raw
    // filesystem artifact plan. Never feed it back into the artifact validator.
    if (candidate?.version === 2 && Array.isArray(candidate?.tasks)) return candidate;
  }
  return null;
}

function latestPlanInFlow(store, task, artifactRoot) {
  try {
    const artifactPlan = currentArtifactPlan(artifactRoot);
    if (artifactPlan) return artifactPlan;
  } catch {
    // During decompose/repair the filesystem may be temporarily incomplete.
    // Validation tasks handle the authoritative error; prompts may fall back
    // to the last valid legacy v2 candidate while writing is in progress.
  }
  return latestLegacyPlanInFlow(store, task, artifactRoot);
}

function failureCount(task) {
  const history = task.history ?? [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type !== 'ROLE_RESULT') continue;
    if (entry.role === 'project_debugger' && entry.outcome === 'WRONG_IMPLEMENTATION_APPROACH') break;
    if ((entry.role === 'tester' || entry.role === 'reviewer') && entry.outcome === 'NOT_PASS') count += 1;
  }
  return count;
}

function strategyEpoch(task) {
  return 1 + (task.history ?? []).filter(
    entry => entry?.type === 'ROLE_RESULT'
      && entry.role === 'project_debugger'
      && entry.outcome === 'WRONG_IMPLEMENTATION_APPROACH'
  ).length;
}

function planningSkipIds(task, round) {
  const batchId = task.input?.planningBatchId;
  if (!batchId) return [];
  const id = name => `planner:${batchId}:${name}`;
  if (round === 1) return [
    id('repair-1'),
    id('validate-2'), id('critic-2'), id('repair-2'),
    id('validate-3'), id('critic-3'), id('repair-3'),
  ];
  if (round === 2) return [
    id('repair-2'),
    id('validate-3'), id('critic-3'), id('repair-3'),
  ];
  if (round === 3) return [id('repair-3')];
  return [];
}

function planningBatchRequests(store, task) {
  const batchId = task.input?.planningBatchId;
  if (!batchId) return [];
  return store.listPlanningRequests(task.projectId).filter(item => item.batchId === batchId);
}

function isTakeoverPlanningTask(store, task) {
  const project = ensureTakeoverReviewState(store, task.projectId);
  return project.mode === 'TAKEOVER' && project.takeoverReviewRequired === true;
}

function iterationRequest(store, task) {
  return planningBatchRequests(store, task).find(item => item.request?.purpose === 'UPDATE_DELIVERY_PLAN') ?? null;
}

function materializeIterationFeatureTree(store, task, artifactRoot) {
  const request = iterationRequest(store, task);
  if (!request) return null;
  const diff = loadFeatureTreeDiff(artifactRoot);
  if (!diff) {
    const error = new Error('ITERATION_FEATURE_TREE_DIFF_REQUIRED: iteration planning requires feature-tree-diff.json');
    error.code = 'ITERATION_FEATURE_TREE_DIFF_REQUIRED';
    throw error;
  }
  const targetVersion = request.context?.targetVersion ?? request.request?.iteration;
  if (diff.targetVersion !== targetVersion) {
    const error = new Error(`ITERATION_FEATURE_TREE_DIFF_REQUIRED: diff targets version ${diff.targetVersion}, expected ${targetVersion}`);
    error.code = 'ITERATION_FEATURE_TREE_DIFF_REQUIRED';
    throw error;
  }
  const project = store.getProject(task.projectId);
  const nextNodes = applyFeatureTreeDiff(project?.logicalNodes ?? [], diff);
  materializeLogicalTree(artifactRoot, nextNodes);
  return { diff, nextNodes };
}


const ARTIST_PROMPT = [
  "You are Ariad's artist role.",
  'Create or source only media assets: images, video, music, audio, sprites, textures, backgrounds, illustrations, and similar pure resources.',
  'Do NOT own UX design, CSS, layout, interaction design, or application logic. Those belong to Developer.',
  'Inspect the actual tool surface available in this run before choosing a media path; do not infer tool availability from memory or prior runs.',
  'For image creation, prefer configured ComfyUI MCP tools when they are available. Use them directly for generation/iteration and keep the work inside the current role run.',
  'Do not use OpenClaw image_generate when ComfyUI MCP is available. image_generate may detach into a background continuation, which can rebuild the tool surface and drop run-scoped tools.',
  'For non-image media, or when ComfyUI MCP is genuinely unavailable, use the best actually available media/source tools. Do not claim an asset was produced if no usable artifact exists.',
  'If a required capability is unavailable, return NEEDS_CAPABILITY and list the missing capabilities. Only use placeholders when task.art.placeholderAllowed is explicitly true.',
  'When revisiting after Tester/Reviewer/Debugger feedback, inspect latest history and modify only the affected assets. Developer and the normal regression flow will run afterward.',
].join(' ');

const DEVELOPER_REUSE_PROMPT = [
  "You are Ariad's developer role.",
  'Inspect task history before changing code.',
  'If TAKEOVER_NOTE or other prior context points to existing implementation, inspect and reuse/fix/extend it when sensible; do not rewrite merely because this task exists in the current plan.',
  'Historical completion is context only. Produce the current implementation required by the acceptance criteria.',
].join(' ');

const TESTER_REUSE_PROMPT = [
  "You are Ariad's tester role.",
  'When media assets or prior Artist work are involved, capture suitable evidence such as screenshots, rendered frames, clips, or audio metadata/checks. If the asset itself appears wrong rather than its integration, describe that diagnosis in the result, but do not route work to another role; Ariad owns repair routing.',
  'Inspect task history and the existing test code before creating new tests.',
  'Reuse valid existing tests. Fix, extend, add, or remove tests only when needed to make them accurately cover the current acceptance criteria.',
  'All relevant verification must be freshly executed now and must produce fresh evidence; historical test passes are not evidence for this run.',
  'Map each acceptance criterion id to actual verification, and do not treat the existence of a similarly named test as sufficient coverage.',
  'For every required criterion return one criteria entry with status SATISFIED, FAILED, UNVERIFIED, or BLOCKED plus evidence and reason. Ariad computes the aggregate verdict; you cannot make PASS override an unsatisfied criterion.',
].join(' ');

const REVIEWER_FRESH_EVIDENCE_PROMPT = [
  "You are Ariad's reviewer role.",
  'When media/art is involved, inspect Tester evidence and judge overall artistic coherence and normal aesthetic quality in addition to correctness. Reject uncanny/broken people, malformed assets, strange presentation caused by assets, mismatched music/audio, and disguised placeholders. If the resource itself appears to need repair, describe that diagnosis in the result, but do not route work to another role; Ariad owns repair routing.',
  'Treat TAKEOVER_NOTE and all historical implementation/test/review claims as context only.',
  'Accept only on the basis of the current Tester run and its fresh evidence against the current acceptance criteria.',
].join(' ');

function plannerPublicPlan(plan) {
  if (!plan) return null;
  const { executionTasks, ...publicPlan } = plan;
  return publicPlan;
}

function plannerPrompt({ store, project, task, artifactRoot }) {
  const purpose = task.input?.purpose;
  const currentPlan = plannerPublicPlan(latestPlanInFlow(store, task, artifactRoot));
  const context = {
    project: {
      id: project.id,
      spec: project.spec ?? null,
      mode: project.mode ?? 'NEW',
      sourcePath: project.sourcePath ?? null,
      deliveryPlanSummary: project.deliveryPlanSummary ?? null,
      projectVersion: project.projectVersion ?? 0,
      activeVersion: project.activeVersion ?? 1,
    },
    planningRequests: task.input?.requests ?? [],
    currentDeliveryPlan: currentPlan,
  };

  if (purpose === 'PLANNER_DECOMPOSE') {
    const nodeType = task.input?.frontierPhase ?? 'feature';
    const frontier = beginFrontierPass(artifactRoot, nodeType);
    return [
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      frontierArtifactInstructions(artifactRoot, nodeType),
      nodeType === 'feature'
        ? 'FEATURE FRONTIER PHASE: define product/behavior decomposition and contracts. Do not create detailed execution tasks yet.'
        : 'MILESTONE FRONTIER PHASE: define delivery/integration decomposition and contracts. Detailed execution tasks are created in the later dependency pass.',
      frontier.bootstrap
        ? frontier.instruction
        : [
            frontier.instruction,
            'The current node already has a parent-facing contract. Preserve every exported interface exactly.',
            'If expanding, define each direct child completely enough to expose its own stable parent-facing contract and decomposition decision.',
            'Then update the current node imports and integrationScenarios so they use only those direct-child exported interfaces.',
          ].join(' '),
      JSON.stringify({
        frontierPhase: nodeType,
        frontier,
      }, null, 2),
      nodeType === 'milestone'
        ? 'Milestone artifacts created during frontier planning may keep tasks=[] temporarily. The later dependency pass must replace that with bounded implementation/integration execution tasks before validation.'
        : null,
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_DEPENDENCIES') {
    return [
      'You are Ariad\'s Tech Lead dependency pass.',
      'Inspect the completed top-down feature and milestone boundary contracts, then COMPILE their task ownership into bounded execution tasks and dependencies in place. Do not emit a monolithic plan.',
      'Feature featureTasks are canonical base tasks: preserve their title, intent, acceptanceCriteria, testStrategy, and feature ownership exactly.',
      'Milestone taskLinks may only add dependencies and verification to linked feature tasks. Never replace or weaken the feature task definition.',
      'Milestone integrationTasks are new milestone-owned tasks for contract/integration/UI-journey/E2E verification.',
      'Leaf implementation scopes should own implementation plus local/unit/component correctness. Parent feature and milestone scopes should own integration/E2E verification derived from their integrationScenarios.',
      'Tester is allowed and expected to author/update cross-feature, milestone-integration, UI-journey, contract, and E2E tests. Developer should not absorb those higher-level integration responsibilities.',
      'Logical parentage is semantic only and never creates an execution dependency.',
      'Milestone parentage is execution structure: child milestones complete before parent integration/E2E work. Do not repeat that implicit ordering in dependsOn.',
      'Use milestone dependsOn only for additional prerequisite milestones and task dependsOn only for precise extra task prerequisites.',
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      plannerArtifactInstructions(artifactRoot),
    ].join('\n\n');
  }

  if (purpose === 'PLANNER_REPAIR') {
    const previous = predecessorResults(store, task)[0]?.result ?? null;
    return [
      'You are Ariad\'s Tech Lead repair pass.',
      'Repair only the affected planner artifacts using the critic findings below. Do not rewrite or re-emit the complete project plan.',
      'Do not add unrelated scope.',
      JSON.stringify({ context, critic: previous }, null, 2),
      plannerArtifactInstructions(artifactRoot),
    ].join('\n\n');
  }

  return buildTechLeadPrompt({ projectContext: context, schema: TECH_LEAD_PLAN_SCHEMA });
}

function criticPrompt({ store, project, task, artifactRoot }) {
  const validation = predecessorResults(store, task)[0]?.result ?? null;
  return [
    'You are Ariad\'s delivery-plan critic.',
    'Review the candidate v2 delivery plan and validator result. Focus on logical-tree quality, milestone structure, project-wide completeness, missing integration/testing responsibility, invalid milestone direction, missing dependencies, over-broad serialization, bad hierarchy, and tasks that are too large.',
    'A plan is incomplete if it only describes the next milestone while known project goals/features clearly continue beyond it. Near-term work may be detailed and later milestones coarse, but the plan must still reach the known project root.',
    'For takeover, explicitly compare authoritative roadmap/milestone/docs against BOTH the logical tree and milestone list. If known major later scope appears in the sources or logical tree but disappears from milestones, return ISSUES. Reject placeholder/unused/TBD milestones that do not represent a real checkpoint.',
    'Submit the critic result through the provider\'s structured role-result mechanism when available. Use outcome CLEAN|MINOR_ONLY|ISSUES and include result.issues plus result.summary. JSON terminal output is fallback only.',
    'On round 3, use MINOR_ONLY when only non-blocking polish remains.',
    JSON.stringify({
      project: { id: project.id, spec: project.spec ?? null },
      round: task.input?.round ?? null,
      validation,
      plan: plannerPublicPlan(validation?.plan ?? latestPlanInFlow(store, task, artifactRoot)),
    }, null, 2),
  ].join('\n\n');
}

export function createDefaultV2Roles({
  store,
  providerId = 'pydantic-v2',
  completionProtocol = 'provider_terminal',
  codeProviderId = 'ariad-code',
  workspace,
  sourceControl = null,
  enqueuePlanning = null,
  artifactRoot = null,
  executionCapabilities = [],
  executionProvenance = {},
  resolveRoleExecutionMetadata = null,
}) {
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

  const executionMetadataFor = (task) => (
    typeof resolveRoleExecutionMetadata === 'function'
      ? structuredClone(resolveRoleExecutionMetadata(task.stage) ?? {})
      : {}
  );

  const executionProvenanceFor = (task) => ({
    ...structuredClone(executionProvenance),
    ...executionMetadataFor(task),
  });

  const prepareLlm = (task, v2Prompt, extra = {}) => {
    const executionMetadata = executionMetadataFor(task);
    const persistentSessionKey = ['pm', 'tech_lead', 'project_debugger'].includes(task.stage)
      ? `${task.stage}:${task.projectId}`
      : null;
    const modelRef = typeof executionMetadata.modelRef === 'string'
      ? executionMetadata.modelRef.trim()
      : '';
    return {
      provider: providerId,
      completionProtocol,
      resources: modelRef.startsWith('llamacpp/') ? ['local-llm'] : [],
      executionCapabilities: [...executionCapabilities],
      executionProvenance: {
        ...structuredClone(executionProvenance),
        ...executionMetadata,
      },
      workspace,
      context: {
        executionCapabilities: [...executionCapabilities],
        ...(modelRef ? { roleModelRef: modelRef } : {}),
        ...(persistentSessionKey ? { sessionKey: persistentSessionKey } : {}),
        ...extra,
        v2Prompt,
        task: {
          id: task.id,
          title: task.title ?? null,
          intent: task.intent ?? task.input?.intent ?? null,
          acceptanceCriteria: task.acceptanceCriteria ?? task.input?.acceptanceCriteria ?? [],
          acceptanceCriterionIds: acceptanceCriterionIds(task),
          verification: task.verification ?? task.input?.verification ?? [],
          testStrategy: task.testStrategy ?? task.input?.testStrategy ?? null,
          art: task.art ?? task.input?.art ?? null,
          history: task.history ?? [],
        },
        executionHandoff: deriveExecutionHandoff(task.history ?? []),
        devCycle: 1 + failureCount(task),
        strategyEpoch: strategyEpoch(task),
      },
    };
  };

  return {
    artist: {
      prepare: ({ task }) => {
        const art = task.art ?? task.input?.art ?? null;
        const capabilities = requiredArtCapabilities(art ?? { required: true, media: [] });
        return prepareLlm(task, ARTIST_PROMPT, {
          art,
          capabilityRequirements: capabilities,
          capabilityRecommendations: artCapabilityRecommendations(capabilities),
        });
      },
      transition: ({ result }) => {
        if (result.outcome === 'PASS') return { stage: 'developer', state: 'READY' };
        return {
          stage: 'project_debugger',
          state: 'READY',
          transitionHistory: {
            type: result.outcome === 'NEEDS_CAPABILITY' ? 'CAPABILITY_REQUIRED' : 'ARTIST_REPAIR_FAILED',
            role: 'artist',
            summary: result.summary ?? 'Artist could not complete the required repair.',
            ...(result.outcome === 'NEEDS_CAPABILITY'
              ? {
                  missingCapabilities: result.result?.missingCapabilities ?? [],
                  recommendations: result.result?.recommendations ?? [],
                }
              : {}),
            at: new Date().toISOString(),
          },
        };
      },
    },

    developer: {
      prepare: ({ task }) => prepareLlm(task, DEVELOPER_REUSE_PROMPT),
      transition: () => ({ stage: 'tester', state: 'READY' }),
    },

    tester: {
      prepare: ({ task }) => prepareLlm(task, TESTER_REUSE_PROMPT, {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
      }),
      transition: ({ task, result }) => {
        if (result.outcome === 'PASS') return { stage: 'reviewer', state: 'READY' };
        if (result.outcome === 'NOT_PASS') {
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        return { stage: 'project_debugger', state: 'READY' };
      },
    },

    reviewer: {
      prepare: ({ task }) => prepareLlm(task, REVIEWER_FRESH_EVIDENCE_PROMPT, {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
      }),
      transition({ task, result }) {
        if (result.outcome === 'NOT_PASS') {
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        if (result.outcome !== 'PASS') return { stage: 'project_debugger', state: 'READY' };
        return { state: 'DONE' };
      },
      async afterPersist({ task }) {
        if (!sourceControl || task.state !== 'DONE') return null;
        store.checkpoint?.();
        const finalized = await sourceControl.finalize({
          taskId: task.id,
          strategyEpoch: strategyEpoch(task),
          devCycle: Math.max(1, failureCount(task) + 1),
        });
        if (finalized.ok) return null;
        const sourceControlFailures = (task.history ?? []).filter(
          entry => entry?.type === 'SYSTEM_INTERRUPTION' && entry?.role === 'source_control'
        ).length;
        return {
          patch: {
            stage: 'reviewer',
            state: sourceControlFailures >= 2 ? 'SYSTEM_BLOCKED' : 'READY',
          },
          transitionHistory: {
            type: 'SYSTEM_INTERRUPTION',
            role: 'source_control',
            failure: finalized.failure ?? 'SOURCE_CONTROL_FAILED',
            at: new Date().toISOString(),
          },
        };
      },
    },

    project_debugger: {
      sessionPolicy: 'persistent',
      prepare: ({ task }) => prepareLlm(task, task.input?.blockedTaskId ? [
        "You are Ariad's unified Project Debugger.",
        'Automatic execution retry has been exhausted for the blocked business task below.',
        'Diagnose the root cause across BOTH project/task causes and execution/runtime/model causes.',
        'A runtime symptom does not imply a runtime root cause. If task size/shape likely caused repeated stalls, use TASK_TOO_LARGE so Tech Lead can split/replan it.',
        'Do not repair files, config, services, processes, task state, or model selection yourself. Return one routing diagnosis.',
        JSON.stringify(task.input?.systemIncident ?? {}, null, 2),
      ].join('\n\n') : null),
      transition: ({ task, result }) => {
        const blockedTaskId = task.input?.blockedTaskId ?? null;
        const blocked = blockedTaskId ? store.getTask(blockedTaskId) : null;
        const routeBlocked = (patch, history) => {
          if (!blocked) return;
          store.appendTaskHistory(blocked.id, blocked.version, history, patch);
        };

        if (result.outcome === 'WRONG_IMPLEMENTATION_APPROACH') {
          if (blocked) {
            routeBlocked({ stage: 'developer', state: 'READY', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'developer',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'developer',
            state: 'READY',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'developer',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'ASSET_ISSUE') {
          if (blocked) {
            routeBlocked({ stage: 'artist', state: 'READY', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'artist',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'artist',
            state: 'READY',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'artist',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'TASK_TOO_LARGE') {
          const targetTaskId = blockedTaskId ?? task.id;
          enqueuePlanning?.({
            request: {
              purpose: 'REPLAN_TASK',
              taskId: targetTaskId,
              diagnosis: result.result ?? result,
            },
          });
          if (blocked) {
            routeBlocked({ stage: 'developer', state: 'WAITING_REPLAN', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'tech_lead',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'developer',
            state: 'WAITING_REPLAN',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'tech_lead',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'SYSTEM_RUNTIME_FAILURE' || result.outcome === 'MODEL_CAPABILITY_MISMATCH') {
          return {
            state: 'NEEDS_HUMAN',
            transitionHistory: {
              type: 'SYSTEM_DIAGNOSIS',
              role: 'project_debugger',
              blockedTaskId,
              diagnosis: result.outcome,
              summary: result.summary ?? result.result?.reason ?? 'Execution failure requires operator action.',
              evidence: result.result?.evidence ?? [],
              affectedComponent: result.result?.affectedComponent ?? null,
              guidance: result.result?.guidance ?? null,
              questions: ['Review the diagnosis, repair the runtime/model policy as appropriate, then explicitly resume the project.'],
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'REQUIREMENT_DECISION_REQUIRED' || result.outcome === 'UNKNOWN_PROJECT_CAUSE') {
          if (blocked) {
            routeBlocked({ stage: 'pm', state: 'READY', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'pm',
              diagnosis: result.outcome,
              summary: result.summary ?? result.result?.reason ?? null,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'pm',
            state: 'READY',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'pm',
              diagnosis: result.outcome,
              summary: result.summary ?? result.result?.reason ?? null,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        return {
          stage: 'pm',
          state: 'READY',
          transitionHistory: {
            type: 'DEBUGGER_ROUTE',
            role: 'project_debugger',
            route: 'pm',
            diagnosis: result.outcome ?? 'UNKNOWN',
            summary: result.summary ?? null,
            at: new Date().toISOString(),
          },
        };
      },
    },

    tech_lead: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        if (artifactRoot) ensurePlannerArtifactLayout(artifactRoot);
        const prompt = [
          plannerPrompt({ store, project, task, artifactRoot }),
          '',
          'FINAL RESULT',
          'After completing all required file writes, submit outcome PLANNED through the provider structured role-result mechanism when available. Use terminal JSON only as a compatibility fallback.',
        ].join('\n');
        return prepareLlm(task, prompt);
      },
      transition: ({ task, result }) => {
        if (result.outcome === 'PLANNED' || result.outcome === 'REPLANNED') {
          if (task.scope === 'control' && task.input?.purpose === 'PLANNER_DECOMPOSE') {
            const nodeType = task.input?.frontierPhase ?? 'feature';
            const pass = finishFrontierPass(artifactRoot, nodeType);
            if (pass.next) {
              return {
                state: 'READY',
                input: {
                  ...task.input,
                  frontierPhase: nodeType,
                },
                transitionHistory: {
                  type: 'PLANNER_FRONTIER_LAYER_COMPLETE',
                  role: 'tech_lead',
                  nodeType,
                  nodeId: pass.targetNodeId,
                  disposition: pass.targetDisposition,
                  childIds: pass.childIds,
                  nextNodeId: pass.next.node?.id ?? null,
                  at: new Date().toISOString(),
                },
              };
            }
            if (nodeType === 'feature') {
              return {
                state: 'READY',
                input: {
                  ...task.input,
                  frontierPhase: 'milestone',
                },
                transitionHistory: {
                  type: 'PLANNER_FRONTIER_PHASE_COMPLETE',
                  role: 'tech_lead',
                  nodeType: 'feature',
                  nextPhase: 'milestone',
                  at: new Date().toISOString(),
                },
              };
            }
            return { state: 'DONE' };
          }
          return task.scope === 'control'
            ? { state: 'DONE' }
            : { stage: 'developer', state: 'WAITING_REPLAN' };
        }
        return {
          stage: 'pm',
          state: 'READY',
          transitionHistory: {
            type: 'TECH_LEAD_ESCALATED_TO_PM',
            role: 'tech_lead',
            summary: result.summary ?? result.result?.reason ?? 'Tech Lead requires a product-level decision before planning can continue.',
            guidance: result.result?.guidance ?? null,
            at: new Date().toISOString(),
          },
        };
      },
    },

    tech_lead_critic: {
      prepare: ({ project, task }) => prepareLlm(task, criticPrompt({ store, project, task, artifactRoot })),
      transition: ({ task, result }) => {
        if (result.outcome === 'CLEAN' || result.outcome === 'MINOR_ONLY') {
          return {
            state: 'DONE',
            skipTaskIds: planningSkipIds(task, task.input?.round),
          };
        }
        return { state: 'DONE' };
      },
    },

    plan_validator: {
      prepare: ({ task }) => ({
        provider: codeProviderId,
        executionProvenance: executionProvenanceFor(task),
        execute: async () => {
          try {
            materializeIterationFeatureTree(store, task, artifactRoot);
          } catch (error) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, plan: null, error: error?.message ?? String(error), errorCode: error?.code ?? null },
            };
          }
          const rawArtifactPlan = loadPlannerArtifactPlan(artifactRoot);
          if (rawArtifactPlan) {
            try {
              const validated = validatePlannerArtifactPlan(rawArtifactPlan);
              if (hasBoundaryContracts(artifactRoot)) {
                validateBoundaryContracts(artifactRoot, 'feature', { allowFrontier: false });
                validateBoundaryContracts(artifactRoot, 'milestone', { allowFrontier: false });
                validateTaskOwnershipCompilation(artifactRoot, validated.plan.tasks);
              }
              validatePlanAutonomy(validated.plan, planningBatchRequests(store, task));
              return {
                outcome: 'PASS',
                result: { valid: true, plan: validated.plan, error: null, errorCode: null },
              };
            } catch (error) {
              return {
                outcome: 'NOT_PASS',
                result: { valid: false, plan: rawArtifactPlan, error: error?.message ?? String(error), errorCode: error?.code ?? null },
              };
            }
          }

          const candidate = latestLegacyPlanInFlow(store, task, artifactRoot);
          if (!candidate) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, error: 'NO_CANDIDATE_PLAN', plan: null },
            };
          }
          try {
            const validated = validateTechLeadPlan(candidate);
            validatePlanAutonomy(validated.plan, planningBatchRequests(store, task));
            return {
              outcome: 'PASS',
              result: { valid: true, plan: validated.plan, error: null, errorCode: null },
            };
          } catch (error) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, plan: candidate, error: error?.message ?? String(error), errorCode: error?.code ?? null },
            };
          }
        },
      }),
      transition: ({ task, result }) => {
        if (task.input?.purpose === 'PLANNER_FINAL_VALIDATE' && result.outcome !== 'PASS') {
          if (result.result?.errorCode === 'INVALID_AUTONOMY_REQUIREMENT') {
            enqueuePlanning?.({
              request: {
                purpose: 'AUTONOMY_REPLAN',
                diagnosis: result.result,
                instruction: 'Replace required external/manual human work with an autonomous verification strategy. Do not weaken the acceptance requirement.',
              },
            });
            return { state: 'DONE' };
          }
          if (['ITERATION_LOGICAL_REVISION_REQUIRED', 'ITERATION_FEATURE_TREE_DIFF_REQUIRED'].includes(result.result?.errorCode)) {
            enqueuePlanning?.({
              request: {
                purpose: 'ITERATION_REVISION_REPLAN',
                diagnosis: result.result,
                instruction: 'Repair feature-tree-diff.json against the immutable previous-version snapshot/current durable logical tree. Use add/update/remove operations with stable ids; Ariad will deterministically materialize the next living feature tree. Do not hand-edit the generated logical tree as the authoritative change description.',
              },
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'tech_lead',
            state: 'READY',
            transitionHistory: {
              type: 'PLANNER_VALIDATION_ESCALATION',
              role: 'plan_validator',
              summary: result.result?.error ?? 'Planner validation failed after deterministic repair paths.',
              errorCode: result.result?.errorCode ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        return { state: 'DONE' };
      },
    },

    pm: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        if (task.scope === 'delivery') {
          const debuggerResult = [...(task.history ?? [])].reverse().find(
            entry => entry?.type === 'ROLE_RESULT' && entry?.role === 'project_debugger'
          ) ?? null;
          const prompt = [
            'You are Ariad\'s PM resolving a product/requirement escalation from Project Debugger.',
            'You own product intent and are the only role allowed to request a human decision.',
            'First decide the product question yourself from the durable project brief/spec, explicit prior user decisions, task acceptance criteria, and task history whenever that evidence is sufficient.',
            'Return PRODUCT_DECISION when you can determine the intended behavior. State the concrete product decision in result.decision and give Tech Lead actionable result.guidance. Do not ask the user merely to approve a repair route.',
            'If task history contains HUMAN_DECISION, treat that explicit user answer as authoritative product input. Convert it into PRODUCT_DECISION unless another genuinely unresolved product question remains.',
            'Return NEEDS_HUMAN only when existing product evidence is genuinely insufficient and a new user/product choice is required. Ask the minimum concrete questions needed.',
            'Do not modify implementation files and do not perform engineering decomposition yourself; Tech Lead will translate your product decision into task/plan changes.',
            JSON.stringify({
              project: { id: project.id, spec: project.spec ?? null, mode: project.mode ?? 'NEW' },
              task: {
                id: task.id,
                title: task.title ?? null,
                input: task.input ?? null,
                stage: task.stage,
                history: task.history ?? [],
              },
              debuggerDiagnosis: debuggerResult,
            }, null, 2),
          ].join('\n\n');
          return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
        }
        const validation = predecessorResults(store, task)[0]?.result ?? null;
        const takeover = isTakeoverPlanningTask(store, task);
        const iteration = iterationRequest(store, task);
        const featureTreeDiff = iteration ? loadFeatureTreeDiff(artifactRoot) : null;
        const prompt = [
          'You are Ariad\'s PM reviewing a validated delivery plan against user intent.',
          'Review both the logical feature/component tree and the milestone structure. The plan must cover the complete currently-known route to project completion, not stop at the next milestone. Near-term work may be detailed and later milestones coarse. Milestones should be useful integrated checkpoints without forcing unnecessary ceremony.',
          'Review the plan as if this product must be handed to real intended users and be good enough to ship, deliver, or sell within its stated scope. Do not accept a plan merely because individual components have isolated tests.',
          'Every important feature and every milestone must have at least one representative end-to-end user scenario: enter through a real supported product entry point, follow the required user-visible steps without shortcuts, exercise the relevant child capabilities together, and reach the intended user-visible outcome.',
          'Do not accept fake E2E that jumps over required workflow state by calling internals directly, injecting final state/data, opening a late screen directly, starting at a final game level, or otherwise bypassing steps an actual user must perform. Focused unit/integration tests may supplement E2E but cannot replace it.',
          'The project/root plan must culminate in a product-level end-to-end journey that demonstrates the intended user can start from a realistic initial state and obtain the product\'s promised value. Require setup/onboarding/persistence/recovery or other lifecycle steps only when they are truly part of that product experience; do not invent unrelated commercial requirements.',
          'For takeover, compare the known authoritative roadmap/docs and the logical tree against the milestone list. Do not accept if known later major scope is missing from milestones, or if the milestone list contains placeholder/unused/TBD entries instead of real checkpoints.',
          'If this is a game project, do not accept a plan whose completion evidence only shows that maps/levels were launched, traversed, or exercised. The product-level E2E must begin from a normal player entry/start state and play through the required progression to an actual win/clear; directly opening the final level or injecting progression state is not a valid full playthrough. Ariad must know how to execute that successful path autonomously without relying on external human players unless the user explicitly requested a human study.',
          takeover
            ? 'This is an existing-project takeover. Verify that the reconstruction is coherent, reuse-first, explains uncertainty, and is ready to show the human. Do not treat historical tests/reviews as current evidence. If the human has already supplied a HUMAN_DECISION in task history, incorporate it explicitly.'
            : null,
          'Submit the PM decision through the provider\'s structured role-result mechanism when available. Use outcome PLAN_ACCEPTED|PLAN_REVISION_REQUIRED|NEEDS_HUMAN with result.reason, result.startDelivery, optional result.guidance, and result.questions. JSON terminal output is fallback only.',
          'Delivery has a durable gate. Tech Lead/validator/critic can never start delivery. For PLAN_ACCEPTED, set result.startDelivery=true only when you explicitly authorize delivery to begin or resume now. Set it false to keep delivery gated. For TAKEOVER, delivery must remain gated until the required human review has been recorded; only a later PM review may explicitly start it.',
          JSON.stringify({
            project: { id: project.id, spec: project.spec ?? null, mode: project.mode ?? 'NEW', sourcePath: project.sourcePath ?? null },
            takeover,
            featureTreeDiff,
            plan: plannerPublicPlan(validation?.plan ?? latestPlanInFlow(store, task, artifactRoot)),
          }, null, 2),
        ].filter(Boolean).join('\n\n');
        return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
      },
      transition: ({ task, result }) => {
        if (task.scope === 'delivery') {
          if (result.outcome === 'PRODUCT_DECISION') {
            const decision = result.result?.decision ?? result.result?.reason ?? result.summary ?? null;
            enqueuePlanning?.({
              request: {
                purpose: 'PRODUCT_DECISION_REPLAN',
                taskId: task.id,
                decision,
                guidance: result.result?.guidance ?? null,
                instruction: 'Translate the PM product decision into the smallest correct engineering change. Amend the current task when local, replan the affected subtree when cross-task, or replan the project only when product scope truly requires it.',
              },
            });
            return {
              stage: 'developer',
              state: 'WAITING_REPLAN',
              transitionHistory: {
                type: 'PRODUCT_DECISION',
                role: 'pm',
                decision,
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          if (result.outcome === 'NEEDS_HUMAN') {
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'PM_HUMAN_DECISION',
                role: 'pm',
                summary: result.summary ?? result.result?.reason ?? 'PM requires a new product decision from the user.',
                questions: result.result?.questions ?? [],
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          return {
            stage: 'pm',
            state: 'READY',
            transitionHistory: {
              type: 'PM_DECISION_RETRY',
              role: 'pm',
              summary: `Unexpected PM delivery-escalation outcome: ${result.outcome}`,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'PLAN_ACCEPTED') {
          const rawArtifactPlan = loadPlannerArtifactPlan(artifactRoot);
          const validated = rawArtifactPlan
            ? validatePlannerArtifactPlan(rawArtifactPlan)
            : validateTechLeadPlan(latestLegacyPlanInFlow(store, task, artifactRoot));
          store.applyDeliveryPlan(task.projectId, validated.plan);
          const takeover = isTakeoverPlanningTask(store, task);
          const hasHumanDecision = (task.history ?? []).some(entry => entry?.type === 'HUMAN_DECISION');
          const setDeliveryEnabled = (enabled) => {
            const current = store.getProject(task.projectId);
            if (current?.deliveryEnabled === enabled) return current;
            return store.updateProject(task.projectId, current.version, { deliveryEnabled: enabled });
          };
          if (takeover && !hasHumanDecision) {
            setDeliveryEnabled(false);
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'PM_HUMAN_DECISION',
                role: 'pm',
                summary: result.result?.reason ?? 'Existing project reconstructed and ready for human takeover review.',
                guidance: result.result?.guidance ?? null,
                questions: result.result?.questions?.length
                  ? result.result.questions
                  : ['Approve the reconstructed current state and delivery plan, or provide corrections.'],
                at: new Date().toISOString(),
              },
            };
          }
          if (takeover && hasHumanDecision) completeTakeoverReview(store, task.projectId);
          setDeliveryEnabled(result.result?.startDelivery === true);
          return {
            state: 'DONE',
            transitionHistory: {
              type: 'DELIVERY_GATE',
              role: 'pm',
              enabled: result.result?.startDelivery === true,
              reason: result.result?.reason ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'PLAN_REVISION_REQUIRED') {
          enqueuePlanning?.({
            request: {
              purpose: 'PM_PLAN_REVISION',
              guidance: result.result?.guidance ?? result.result ?? null,
            },
          });
          return { state: 'DONE' };
        }
        if (result.outcome === 'NEEDS_HUMAN') {
          return {
            state: 'NEEDS_HUMAN',
            transitionHistory: {
              type: 'PM_HUMAN_DECISION',
              role: 'pm',
              summary: result.summary ?? result.result?.reason ?? 'PM requires a new product decision from the user.',
              guidance: result.result?.guidance ?? null,
              questions: result.result?.questions ?? [],
              at: new Date().toISOString(),
            },
          };
        }
        return {
          stage: 'tech_lead',
          state: 'READY',
          transitionHistory: {
            type: 'PM_ESCALATED_TO_TECH_LEAD',
            role: 'pm',
            summary: result.summary ?? result.result?.reason ?? 'PM requires planning revision.',
            guidance: result.result?.guidance ?? null,
            at: new Date().toISOString(),
          },
        };
      },
    },
  };
}
