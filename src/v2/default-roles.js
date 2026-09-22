import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { TECH_LEAD_PLAN_SCHEMA, validateTechLeadPlan } from './tech-lead-plan.js';
import { buildTechLeadPrompt } from './tech-lead-prompt.js';
import { artCapabilityRecommendations, requiredArtCapabilities } from './art-capabilities.js';
import { acceptanceCriterionIds } from './acceptance.js';
import { validatePlanAutonomy } from './autonomy.js';
import {
  ensurePlannerArtifactLayout,
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
  const project = store.getProject(task.projectId);
  if (project?.mode === 'TAKEOVER') return true;
  return planningBatchRequests(store, task).some(item => item.request?.purpose === 'RESTORE_PROJECT_STATE');
}

const ARTIST_PROMPT = [
  "You are Ariad's artist role.",
  'Create or source only media assets: images, video, music, audio, sprites, textures, backgrounds, illustrations, and similar pure resources.',
  'Do NOT own UX design, CSS, layout, interaction design, or application logic. Those belong to Developer.',
  'Use the media tools actually available to you (for example ComfyUI, generation tools, browser/search/download tools). Do not claim an asset was produced if no usable artifact exists.',
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
  'When media assets or prior Artist work are involved, capture suitable evidence such as screenshots, rendered frames, clips, or audio metadata/checks. If the asset itself is wrong rather than its integration, return NOT_PASS with result.routeTo="artist".',
  'Inspect task history and the existing test code before creating new tests.',
  'Reuse valid existing tests. Fix, extend, add, or remove tests only when needed to make them accurately cover the current acceptance criteria.',
  'All relevant verification must be freshly executed now and must produce fresh evidence; historical test passes are not evidence for this run.',
  'Map each acceptance criterion id to actual verification, and do not treat the existence of a similarly named test as sufficient coverage.',
  'For every required criterion return one criteria entry with status SATISFIED, FAILED, UNVERIFIED, or BLOCKED plus evidence and reason. Ariad computes the aggregate verdict; you cannot make PASS override an unsatisfied criterion.',
].join(' ');

const REVIEWER_FRESH_EVIDENCE_PROMPT = [
  "You are Ariad's reviewer role.",
  'When media/art is involved, inspect Tester evidence and judge overall artistic coherence and normal aesthetic quality in addition to correctness. Reject uncanny/broken people, malformed assets, strange presentation caused by assets, mismatched music/audio, and disguised placeholders. If the resource itself needs repair, return NOT_PASS with result.routeTo="artist".',
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
    return [
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      plannerArtifactInstructions(artifactRoot),
      'Create the complete known project-wide Logical Tree and Milestone execution tree as bounded artifacts. Later milestones may be coarser, but known future scope must remain represented.',
    ].join('\n\n');
  }

  if (purpose === 'PLANNER_DEPENDENCIES') {
    return [
      'You are Ariad\'s Tech Lead dependency pass.',
      'Inspect the existing planner artifacts and reconcile execution dependencies in place. Do not emit a monolithic plan.',
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
  providerId = 'openclaw-v2',
  codeProviderId = 'ariad-code',
  workspace,
  sourceControl = null,
  enqueuePlanning = null,
  artifactRoot = null,
}) {
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

  const prepareLlm = (task, v2Prompt, extra = {}) => ({
    provider: providerId,
    completionProtocol: 'role_result_tool',
    workspace,
    context: {
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
      devCycle: 1 + failureCount(task),
      strategyEpoch: strategyEpoch(task),
    },
  });

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
        if (result.outcome === 'NEEDS_CAPABILITY') {
          return {
            state: 'NEEDS_HUMAN',
            transitionHistory: {
              type: 'CAPABILITY_REQUIRED',
              role: 'artist',
              summary: result.summary ?? 'Artist capability is missing.',
              missingCapabilities: result.result?.missingCapabilities ?? [],
              recommendations: result.result?.recommendations ?? [],
              at: new Date().toISOString(),
            },
          };
        }
        return { state: 'NEEDS_HUMAN' };
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
          if (result.result?.routeTo === 'artist') return { stage: 'artist', state: 'READY' };
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        return { state: 'NEEDS_HUMAN' };
      },
    },

    reviewer: {
      prepare: ({ task }) => prepareLlm(task, REVIEWER_FRESH_EVIDENCE_PROMPT, {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
      }),
      transition({ task, result }) {
        if (result.outcome === 'NOT_PASS') {
          if (result.result?.routeTo === 'artist') return { stage: 'artist', state: 'READY' };
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        if (result.outcome !== 'PASS') return { state: 'NEEDS_HUMAN' };
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
      prepare: ({ task }) => prepareLlm(task, null),
      transition: ({ task, result }) => {
        if (result.outcome === 'ASSET_ISSUE') return { stage: 'artist', state: 'READY' };
        if (result.outcome === 'WRONG_IMPLEMENTATION_APPROACH') {
          return strategyEpoch(task) >= 3
            ? { state: 'NEEDS_HUMAN' }
            : { stage: 'developer', state: 'READY' };
        }
        if (result.outcome === 'TASK_TOO_LARGE') {
          enqueuePlanning?.({
            request: {
              purpose: 'REPLAN_TASK',
              taskId: task.id,
              diagnosis: result.result ?? result,
            },
          });
          return { stage: 'developer', state: 'WAITING_REPLAN' };
        }
        return { state: 'NEEDS_HUMAN' };
      },
    },

    tech_lead: {
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
        if (task.scope === 'control') return { state: 'DONE' };
        return result.outcome === 'PLANNED' || result.outcome === 'REPLANNED'
          ? { stage: 'developer', state: 'WAITING_REPLAN' }
          : { state: 'NEEDS_HUMAN' };
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
        execute: async () => {
          const rawArtifactPlan = loadPlannerArtifactPlan(artifactRoot);
          if (rawArtifactPlan) {
            try {
              const validated = validatePlannerArtifactPlan(rawArtifactPlan);
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
          return { state: 'NEEDS_HUMAN' };
        }
        return { state: 'DONE' };
      },
    },

    pm: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        const validation = predecessorResults(store, task)[0]?.result ?? null;
        const takeover = isTakeoverPlanningTask(store, task);
        const prompt = [
          'You are Ariad\'s PM reviewing a validated delivery plan against user intent.',
          'Review both the logical feature/component tree and the milestone structure. The plan must cover the complete currently-known route to project completion, not stop at the next milestone. Near-term work may be detailed and later milestones coarse. Milestones should be useful integrated checkpoints without forcing unnecessary ceremony.',
          'For takeover, compare the known authoritative roadmap/docs and the logical tree against the milestone list. Do not accept if known later major scope is missing from milestones, or if the milestone list contains placeholder/unused/TBD entries instead of real checkpoints.',
          takeover
            ? 'This is an existing-project takeover. Verify that the reconstruction is coherent, reuse-first, explains uncertainty, and is ready to show the human. Do not treat historical tests/reviews as current evidence. If the human has already supplied a HUMAN_DECISION in task history, incorporate it explicitly.'
            : null,
          'Submit the PM decision through the provider\'s structured role-result mechanism when available. Use outcome PLAN_ACCEPTED|PLAN_REVISION_REQUIRED|NEEDS_HUMAN with result.reason, result.startDelivery, optional result.guidance, and result.questions. JSON terminal output is fallback only.',
          'Delivery has a durable gate. Tech Lead/validator/critic can never start delivery. For PLAN_ACCEPTED, set result.startDelivery=true only when you explicitly authorize delivery to begin or resume now. Set it false to keep delivery gated. For TAKEOVER, delivery must remain gated until the required human review has been recorded; only a later PM review may explicitly start it.',
          JSON.stringify({
            project: { id: project.id, spec: project.spec ?? null, mode: project.mode ?? 'NEW', sourcePath: project.sourcePath ?? null },
            takeover,
            plan: plannerPublicPlan(validation?.plan ?? latestPlanInFlow(store, task, artifactRoot)),
          }, null, 2),
        ].filter(Boolean).join('\n\n');
        return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
      },
      transition: ({ task, result }) => {
        if (result.outcome === 'PLAN_ACCEPTED') {
          const rawArtifactPlan = loadPlannerArtifactPlan(artifactRoot);
          const validated = rawArtifactPlan
            ? validatePlannerArtifactPlan(rawArtifactPlan)
            : validateTechLeadPlan(latestLegacyPlanInFlow(store, task, artifactRoot));
          store.applyDeliveryPlan(task.projectId, validated.plan);
          const takeover = isTakeoverPlanningTask(store, task);
          const hasHumanDecision = (task.history ?? []).some(entry => entry?.type === 'HUMAN_DECISION');
          const project = store.getProject(task.projectId);
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
                type: 'TAKEOVER_REVIEW',
                role: 'pm',
                summary: result.result?.reason ?? 'Existing project reconstructed and ready for human takeover review.',
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
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
        return { state: 'NEEDS_HUMAN' };
      },
    },
  };
}
