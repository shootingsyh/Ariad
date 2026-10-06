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
  buildOwnedExecutionTasks,
  finishFrontierPass,
  frontierArtifactInstructions,
  nextBoundaryFrontier,
  validateFrontierPass,
  hasBoundaryContracts,
  validateBoundaryContracts,
  validateTaskOwnershipCompilation,
} from './interface-contracts.js';
import { deriveExecutionHandoff } from '../runtime/role-run-prompt.js';
import { buildRoleBoundaryContext } from './role-boundary-context.js';
import { sealRoleInterfaces } from './interface-seal.js';
import { completePlanningModelMigration } from './version-migration.js';
import { reconcileMigratedDeliveryTasks } from './migration-reconciler.js';
import {
  beginRevisionPass,
  finishRevisionPass,
  nextRevisionFrontier,
  revisionInstructions,
} from './revision-traversal.js';
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

function roleSealFailureCount(task, role) {
  const history = task.history ?? [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (
      (entry?.type === 'ROLE_RESULT' && entry.role === 'project_debugger')
      || entry?.type === 'DEBUGGER_ROUTE'
    ) break;
    if (entry?.type === 'ROLE_SEAL_FAILED' && entry.ownerRole === role) count += 1;
    if (role === 'developer' && entry?.type === 'INTERFACE_SEAL_FAILED') count += 1;
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


function latestFrontierCompletion(store, task) {
  const tasks = flowTasks(store, task);
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const history = tasks[i]?.history ?? [];
    for (let j = history.length - 1; j >= 0; j -= 1) {
      if (history[j]?.type === 'PLANNER_FRONTIER_LAYER_COMPLETE') return history[j];
    }
  }
  return null;
}

function migrationRevisionRoot(store, projectId) {
  return store.getProject(projectId)?.planningModelMigration?.legacyRevisionRoot ?? null;
}

function migrationPlanningRequest(store, task) {
  return planningBatchRequests(store, task).find(
    item => ['VERSION_MIGRATION', 'VERSION_MIGRATION_FINALIZE'].includes(item.request?.purpose)
  ) ?? null;
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


function deliveryRoleSuffix(role) {
  if (role === 'developer') {
    return [
      "YOUR ROLE: DEVELOPER",
      "Implement the assigned task and the interfaces listed in the shared task context.",
      "Make the smallest correct implementation that satisfies the interface contracts and acceptance criteria. Run appropriate local/unit/component checks and avoid unrelated refactors.",
      "Interface ownership is already defined by the plan. Do not invent, remove, rename, or silently reassign interfaces.",
      "When a required interface realization is newly created or relocated, return result.interfaceRealizations with {interfaceId, anchors:[{kind:\"symbol\"|\"range\",file,symbol?,startLine?,endLine?}]}. These are hints only; Ariad independently resolves and seals them.",
      "If an existing binding remains valid and unchanged, you do not need to restate it.",
      "If implementation requires a new interface, changes an existing interface's meaning, or reveals the task belongs to a different boundary, report the planning/interface mismatch instead of silently changing the contract.",
      "Before completion, ensure every required interface is implemented and any new or relocated realization is identified.",
    ].join('\n');
  }
  if (role === 'tester') {
    return [
      "YOUR ROLE: TESTER",
      "Verify that implemented behavior satisfies the required interface contracts and task acceptance criteria.",
      "Ariad has already performed mechanical Interface Seal checks such as binding existence and anchor resolvability. Do not redo those checks as your primary task; verify behavior.",
      "For each required Executor, derive verification from its input, output, and sideEffects. For each required Provider, verify both that the provider produces the promised thing and that the produced thing behaves according to its own input/output/sideEffects contract.",
      "Use realistic entry points and state transitions. Prefer executable evidence over inspection-only reasoning. Add or update test code when needed, and do not bypass required product flow merely to make a test pass.",
      "For PASS, return result.interfaceVerifications for every required interface as [{interfaceId,evidence:[...],anchors?:[{kind:\"symbol\"|\"range\",file,symbol?,startLine?,endLine?}]}]. Evidence is required. When verification code has a stable source location, include anchors so Ariad can independently resolve and persist them.",
      "PASS requires behavioral evidence for every required interface relevant to this task. If a sealed realization does not satisfy its contract, return NOT_PASS and identify the failed interface. If the contract is inconsistent or impossible, report that rather than weakening the test.",
    ].join('\n');
  }
  if (role === 'reviewer') {
    return [
      "YOUR ROLE: REVIEWER",
      "Review the completed task as an evidence chain: task ownership -> required interface contract -> implementation realization -> Tester verification -> acceptance criteria.",
      "Do not redo repository-wide discovery or repeat Tester work unless evidence is contradictory or insufficient.",
      "For every required interface, check that the implementation is appropriate for the owning Feature and abstraction level, the realization plausibly corresponds to the contract, and Tester evidence exercises the important inputs, outputs, and sideEffects.",
      "For Providers, require evidence for both provider creation and behavior of the produced thing.",
      "Reject missing links, prose-only claims where executable evidence should exist, silent semantic interface changes, and integration code owned at the wrong Feature or Milestone level.",
      "For PASS, return result.interfaceReviews for every required interface as [{interfaceId,status:\"APPROVED\",reason}]. Ariad independently checks the realization and Tester verification chain before accepting the review.",
      "PASS only when contract, implementation, evidence, and acceptance criteria agree. On NOT_PASS identify the exact broken interface/evidence link.",
    ].join('\n');
  }
  return null;
}

function buildSharedTaskPrompt(task, roleBoundaryContext) {
  const requiredInterfaceIds = task.interfaceIds ?? task.input?.interfaceIds ?? [];
  return [
    "SHARED TASK CONTEXT",
    "You are working on one Ariad delivery task. Developer, Tester, and Reviewer receive this same task-level context.",
    JSON.stringify({
      task: {
        id: task.id,
        title: task.title ?? null,
        intent: task.intent ?? task.input?.intent ?? null,
        acceptanceCriteria: task.acceptanceCriteria ?? task.input?.acceptanceCriteria ?? [],
        owningFeatureRefs: task.logicalRefs ?? task.input?.logicalRefs ?? [],
        milestoneId: task.milestoneId ?? task.input?.milestoneId ?? null,
        requiredInterfaceIds,
      },
      boundaryContext: roleBoundaryContext,
    }, null, 2),
    "INTERFACE RULES",
    "Interface ownership is defined by the plan, not invented after implementation. A task may own multiple interfaces; every required interface must be accounted for.",
    "An Executor contract describes input, output, and sideEffects. A Provider contract describes provider input plus the produced thing and that thing's input, output, and sideEffects.",
    "Parent Features own interfaces at their own abstraction level. Child interfaces may realize a parent interface but do not replace the parent contract. A facade may expose a child interface by reference only when that is genuinely the intended abstraction.",
    "Use the supplied interface/binding context as the primary reasoning boundary. Expand outward only when it is demonstrably insufficient; do not perform unrelated repository-wide rediscovery.",
    "Task completion requires the required contracts to be implemented, mechanically bindable to real code, behaviorally verified, and supported by reviewable evidence.",
  ].join('\n\n');
}

function composeDeliveryRolePrompt(task, roleBoundaryContext, suffix) {
  return [
    buildSharedTaskPrompt(task, roleBoundaryContext),
    suffix,
  ].filter(Boolean).join('\n\n');
}

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
    const revisionRoot = task.input?.versionMigration ? migrationRevisionRoot(store, task.projectId) : null;
    const revision = revisionRoot && task.input?.sourceComplete !== true
      ? beginRevisionPass(revisionRoot, nodeType)
      : null;
    const frontier = beginFrontierPass(artifactRoot, nodeType);
    return [
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      frontierArtifactInstructions(artifactRoot, nodeType),
      revision && !revision.complete ? [
        'VERSION MIGRATION SOURCE FRONTIER',
        'The archived tree is the authoritative traversal source for this round.',
        'Write exactly one KEEP|AMEND|REMOVE|REFINE revision decision for the legacy node before completing this round.',
        'During planning-model migration, KEEP and AMEND should normally keep visitChildren=true because every legacy descendant must receive a fresh interface contract under the new schema.',
        'Use REFINE with visitChildren=false when the old descendants should be replaced by a newly decomposed subtree.',
        'REMOVE skips materializing this legacy node in the new tree.',
        revisionInstructions(revisionRoot, nodeType),
        JSON.stringify({ legacyRevisionFrontier: revision }, null, 2),
      ].join('\n\n') : null,
      nodeType === 'feature'
        ? 'FEATURE FRONTIER PHASE: define product/behavior decomposition, boundary contracts, and the canonical implementation/local-test tasks owned by every node created or finalized in this round. Do not defer task intent to a later global pass.'
        : 'MILESTONE FRONTIER PHASE: define delivery/integration decomposition, feature interface uses, additive links to feature tasks, and milestone-owned integration/E2E tasks for every node created or finalized in this round. Do not defer integration test ownership to a later global pass.',
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
        legacyRevisionFrontier: revision,
      }, null, 2),
      nodeType === 'milestone'
        ? 'Milestone artifacts may keep legacy tasks=[] as a compatibility view; canonical task ownership now lives in the milestone boundary contract (featureUses/taskLinks/integrationTasks).'
        : 'A leaf Feature that requires implementation should own its canonical featureTasks now. A pure composition node may own no implementation task and instead express integrationScenarios.'
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_DEPENDENCIES') {
    const canonicalTasks = hasBoundaryContracts(artifactRoot)
      ? buildOwnedExecutionTasks(artifactRoot)
      : [];
    return [
      'You are Ariad\'s Tech Lead dependency compilation pass.',
      'DO NOT invent, rename, rewrite, broaden, or reinterpret task intent here. Feature and milestone frontier passes already own task definition.',
      'Compile the already-defined canonical featureTasks, milestone taskLinks, and milestone integrationTasks into the legacy milestone/tasks compatibility artifacts and add only precise dependency edges required for execution ordering.',
      'Feature task title, intent, acceptanceCriteria, testStrategy, and feature ownership are immutable in this pass.',
      'Milestone taskLinks may only add dependencies and verification. Milestone integrationTasks are already defined and must remain milestone-owned.',
      'Tester owns milestone/cross-feature integration, UI-journey, contract, and E2E test implementation/execution; Developer owns feature implementation plus local/unit/component correctness.',
      'Logical parentage is semantic only and never creates an execution dependency.',
      'Milestone parentage is execution structure: child milestones complete before parent integration/E2E work. Do not repeat that implicit ordering in dependsOn.',
      'Use milestone dependsOn only for additional prerequisite milestones and task dependsOn only for precise extra task prerequisites.',
      canonicalTasks.length
        ? 'ARIAD CANONICAL TASKS (copy semantics exactly; only compile dependency/milestone placement):\n' + JSON.stringify(canonicalTasks, null, 2)
        : null,
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      plannerArtifactInstructions(artifactRoot),
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_FRONTIER_REPAIR') {
    const previous = predecessorResults(store, task)[0] ?? null;
    const frontier = latestFrontierCompletion(store, task);
    return [
      "You are Ariad's Tech Lead repairing exactly one migration frontier.",
      'Repair only the current frontier artifacts identified below. Do not alter already-frozen ancestor exports or unrelated siblings.',
      'Address only concrete critic issues. Preserve accepted node identity and product intent.',
      JSON.stringify({
        context,
        frontier,
        critic: previous?.result ?? previous ?? null,
      }, null, 2),
      frontierArtifactInstructions(artifactRoot, task.input?.frontierPhase ?? 'feature'),
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
  if (task.input?.purpose === 'PLANNER_FRONTIER_CRITIC') {
    const frontier = latestFrontierCompletion(store, task);
    return [
      "You are Ariad's semantic critic for exactly one top-down migration frontier.",
      'Review only the frontier just produced, plus the parent contract needed to judge it.',
      'Check: correct abstraction level, interface quality, Executor/Provider semantics where applicable, stable parent boundary, sensible child decomposition, task/interface ownership, and whether the frontier preserves project intent.',
      'Do not request unrelated tree-wide cleanup. Return CLEAN when this frontier is acceptable; otherwise ISSUES with precise, locally repairable findings.',
      JSON.stringify({
        project: { id: project.id, spec: project.spec ?? null },
        frontier,
        validation,
      }, null, 2),
    ].join('\n\n');
  }
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
  providerId = 'pi-agent-session',
  completionProtocol = 'provider_terminal',
  codeProviderId = 'ariad-code',
  workspace,
  sourceControl = null,
  enqueuePlanning = null,
  artifactRoot = null,
  executionCapabilities = [],
  executionProvenance = {},
  resolveRoleExecutionMetadata = null,
  codeIntelligence = null,
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
    const sharedDeliveryContext = ['developer', 'tester', 'reviewer'].includes(task.stage);
    const roleBoundaryContext = buildRoleBoundaryContext({
      artifactRoot,
      task,
      role: sharedDeliveryContext ? 'delivery' : task.stage,
      workspace,
    });
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
        role: task.stage,
        executionCapabilities: [...executionCapabilities],
        ...(modelRef ? {
          roleModelRef: modelRef,
          roleModels: { [task.stage]: modelRef },
        } : {}),
        ...(persistentSessionKey ? { sessionKey: persistentSessionKey } : {}),
        ...extra,
        ...(roleBoundaryContext ? { roleBoundaryContext } : {}),
        v2Prompt: ['developer', 'tester', 'reviewer'].includes(task.stage)
          ? composeDeliveryRolePrompt(task, roleBoundaryContext, v2Prompt)
          : v2Prompt,
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

  const sealAfterPersist = async (role, task, result) => {
    const seal = await sealRoleInterfaces({
      role,
      artifactRoot,
      workspace,
      task,
      result,
      codeIntelligence,
    });
    if (!seal.required) return null;
    if (!seal.ok) {
      const repairRole = seal.repairRole ?? role;
      const priorFailures = roleSealFailureCount(task, role);
      const exhaustedRepairBudget = priorFailures >= 3;
      return {
        patch: {
          stage: exhaustedRepairBudget ? 'project_debugger' : repairRole,
          state: 'READY',
          execution: null,
        },
        transitionHistory: {
          type: 'ROLE_SEAL_FAILED',
          role: 'interface_seal',
          ownerRole: role,
          repairRole,
          featureId: seal.featureId ?? null,
          failures: seal.failures ?? [],
          repairAttempt: Math.max(0, priorFailures),
          repairBudget: 3,
          ...(exhaustedRepairBudget ? { escalatedTo: 'project_debugger' } : {}),
          at: new Date().toISOString(),
        },
      };
    }
    return {
      transitionHistory: {
        type: 'ROLE_SEALED',
        role: 'interface_seal',
        ownerRole: role,
        featureId: seal.featureId ?? null,
        sealed: seal.sealed ?? [],
        observedCommit: seal.observedCommit ?? null,
        at: new Date().toISOString(),
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
      prepare: ({ task }) => prepareLlm(task, [
        DEVELOPER_REUSE_PROMPT,
        deliveryRoleSuffix('developer'),
      ].join('\n\n')),
      transition: () => ({ stage: 'tester', state: 'READY' }),
      async afterPersist({ task, result }) {
        return sealAfterPersist('developer', task, result);
      },
    },

    tester: {
      prepare: ({ task }) => prepareLlm(task, [
        TESTER_REUSE_PROMPT,
        deliveryRoleSuffix('tester'),
      ].join('\n\n'), {
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
      async afterPersist({ task, result }) {
        return sealAfterPersist('tester', task, result);
      },
    },

    reviewer: {
      prepare: ({ task }) => prepareLlm(task, [
        REVIEWER_FRESH_EVIDENCE_PROMPT,
        deliveryRoleSuffix('reviewer'),
      ].join('\n\n'), {
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
      async afterPersist({ task, result }) {
        const sealFollowUp = await sealAfterPersist('reviewer', task, result);
        if (sealFollowUp) {
          if (sealFollowUp.patch) return sealFollowUp;
          if (!sourceControl || task.state !== 'DONE') return sealFollowUp;
        }
        if (!sourceControl || task.state !== 'DONE') return sealFollowUp;
        store.checkpoint?.();
        const finalized = await sourceControl.finalize({
          taskId: task.id,
          strategyEpoch: strategyEpoch(task),
          devCycle: Math.max(1, failureCount(task) + 1),
        });
        if (finalized.ok) return sealFollowUp;
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
      prepare: ({ task }) => {
        if (task.input?.purpose === 'PLANNER_FRONTIER_DEBUG') {
          const critics = flowTasks(store, task)
            .filter(item => item.input?.purpose === 'PLANNER_FRONTIER_CRITIC')
            .map(item => ({
              round: item.input?.round ?? null,
              result: latestRoleResult(item),
            }));
          return prepareLlm(task, [
            "You are Ariad's Project Debugger diagnosing one planning frontier after three failed semantic critic rounds.",
            'Do not edit planner artifacts. Judge both the Tech Lead and the critics.',
            'You may return OVERRIDE_CRITIC when the current frontier is sound and the critic objections are wrong, irrelevant, contradictory, or overreaching. Ariad will freeze the frontier and continue.',
            'You may return RETRY_WITH_GUIDANCE when the frontier still needs work but a concrete Tech Lead correction is possible. Put precise corrective instructions in result.guidance. Ariad will start a fresh three-round TL/validator/critic cycle on the same frontier.',
            'Use REQUIREMENT_DECISION_REQUIRED when the disagreement exposes a genuine product ambiguity that PM must resolve.',
            'Use MODEL_CAPABILITY_MISMATCH or SYSTEM_RUNTIME_FAILURE only when execution/model/tooling is actually the cause.',
            'Do not choose RETRY_WITH_GUIDANCE without giving actionable guidance, and do not choose OVERRIDE_CRITIC merely to make progress.',
            JSON.stringify({
              frontierPhase: task.input?.frontierPhase ?? null,
              frontier: latestFrontierCompletion(store, task),
              critics,
            }, null, 2),
          ].join('\n\n'));
        }
        return prepareLlm(task, task.input?.blockedTaskId ? [
          "You are Ariad's unified Project Debugger.",
          'Automatic execution retry has been exhausted for the blocked business task below.',
          'Diagnose the root cause across BOTH project/task causes and execution/runtime/model causes.',
          'A runtime symptom does not imply a runtime root cause. If task size/shape likely caused repeated stalls, use TASK_TOO_LARGE so Tech Lead can split/replan it.',
          'Do not repair files, config, services, processes, task state, or model selection yourself. Return one routing diagnosis.',
          JSON.stringify(task.input?.systemIncident ?? {}, null, 2),
        ].join('\n\n') : null);
      },
      transition: ({ task, result }) => {
        if (task.input?.purpose === 'PLANNER_FRONTIER_DEBUG') {
          const batchId = task.input?.planningBatchId;
          if (result.outcome === 'OVERRIDE_CRITIC') {
            return {
              state: 'DONE',
              transitionHistory: {
                type: 'PLANNER_FRONTIER_CRITIC_OVERRIDDEN',
                role: 'project_debugger',
                frontierPhase: task.input?.frontierPhase ?? null,
                summary: result.summary ?? result.result?.reason ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          if (result.outcome === 'RETRY_WITH_GUIDANCE') {
            enqueuePlanning?.({
              request: {
                purpose: 'VERSION_MIGRATION',
                frontierPhase: task.input?.frontierPhase ?? 'feature',
                debuggerGuidance: result.result?.guidance ?? result.summary ?? null,
                retryOfPlanningBatchId: batchId ?? null,
              },
            });
            return {
              state: 'DONE',
              skipTaskIds: batchId ? [`planner:${batchId}:frontier-finalize`] : [],
              transitionHistory: {
                type: 'PLANNER_FRONTIER_DEBUGGER_RETRY',
                role: 'project_debugger',
                frontierPhase: task.input?.frontierPhase ?? null,
                guidance: result.result?.guidance ?? result.summary ?? null,
                at: new Date().toISOString(),
              },
            };
          }
        }
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
            const revisionRoot = task.input?.versionMigration ? migrationRevisionRoot(store, task.projectId) : null;
            const revisionPass = revisionRoot && task.input?.sourceComplete !== true
              ? finishRevisionPass(revisionRoot, nodeType)
              : null;
            if (revisionPass?.decision?.action === 'REMOVE') {
              return {
                state: 'DONE',
                transitionHistory: {
                  type: 'PLANNER_FRONTIER_LAYER_COMPLETE',
                  role: 'tech_lead',
                  nodeType,
                  nodeId: revisionPass.decision.nodeId,
                  disposition: 'remove',
                  childIds: [],
                  nextNodeId: revisionPass.next?.node?.id ?? null,
                  revisionDecision: revisionPass.decision,
                  at: new Date().toISOString(),
                },
              };
            }
            const pass = finishFrontierPass(artifactRoot, nodeType);
            if (revisionPass?.decision && pass.targetNodeId !== revisionPass.decision.nodeId) {
              throw new Error(`VERSION_MIGRATION_FRONTIER_MISMATCH: legacy ${revisionPass.decision.nodeId} != new ${pass.targetNodeId}`);
            }
            const frontierHistory = {
              type: 'PLANNER_FRONTIER_LAYER_COMPLETE',
              role: 'tech_lead',
