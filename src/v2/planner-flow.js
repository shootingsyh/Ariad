import { TASK_KINDS } from './control-task-policy.js';

function taskId(batchId, name) {
  return `planner:${batchId}:${name}`;
}

// Three-pass feature pipeline (owner decision, 2026-11-01): a version
// planning batch no longer authors the feature tree, the interfaces and
// the task tree in one Tech Lead pass. The work is split into three
// passes, each closed by the deterministic validator and the critic
// (there is deliberately no intermediate PM gate); the PM reviews the
// complete plan once, at the end:
//   pass 1 PLANNER_FEATURES_FUNCTIONAL    - functional features + docs
//   pass 2 PLANNER_FEATURES_NONFUNCTIONAL - non-functional features + docs
//   pass 3 PLANNER_DECOMPOSE              - interfaces + milestone tasks
// Every other batch purpose (triage, task replan, PM revision loops)
// keeps the single-pass flow below.
export const THREE_PASS_REQUEST_PURPOSES = ['INITIAL_PLAN', 'UPDATE_DELIVERY_PLAN'];

export function usesThreePassFlow(requests) {
  return (requests ?? []).some(item => THREE_PASS_REQUEST_PURPOSES.includes(item?.request?.purpose));
}

export function plannerFlowTasks(batchId, requests) {
  // Requirements-first flow (design 2026-10-31): a versioned iteration
  // whose requirements document is not yet human-approved starts with
  // a single PM authoring task, not a decomposition. The PM writes or
  // revises .ariad/docs/REQUIREMENTS.md and escalates for human
  // approval; the follow-on INITIAL_PLAN request is enqueued when
  // that stage completes (see the PM transition in default-roles).
  if (requests.length === 1 && requests[0]?.request?.purpose === 'REQUIREMENTS_AUTHORING') {
    return [
      { id: taskId(batchId, 'requirements'), stage: 'pm', input: {
        planningBatchId: batchId, purpose: 'REQUIREMENTS_AUTHORING',
        requests: structuredClone(requests),
      } },
    ];
  }

  const ids = {
    decompose: taskId(batchId, 'decompose'),
    requirementsDelta: taskId(batchId, 'requirements-delta'),
    dependencies: taskId(batchId, 'dependencies'),
    featuresFunctional: taskId(batchId, 'features-functional'),
    validateFunctional: taskId(batchId, 'validate-functional'),
    criticFunctional: taskId(batchId, 'critic-functional'),
    repairFunctional: taskId(batchId, 'repair-functional'),
    featuresNonfunctional: taskId(batchId, 'features-nonfunctional'),
    validateNonfunctional: taskId(batchId, 'validate-nonfunctional'),
    criticNonfunctional: taskId(batchId, 'critic-nonfunctional'),
    repairNonfunctional: taskId(batchId, 'repair-nonfunctional'),
    validate1: taskId(batchId, 'validate-1'),
    critic1: taskId(batchId, 'critic-1'),
    repair1: taskId(batchId, 'repair-1'),
    validate2: taskId(batchId, 'validate-2'),
    critic2: taskId(batchId, 'critic-2'),
    repair2: taskId(batchId, 'repair-2'),
    validate3: taskId(batchId, 'validate-3'),
    critic3: taskId(batchId, 'critic-3'),
    repair3: taskId(batchId, 'repair-3'),
    finalValidate: taskId(batchId, 'final-validate'),
    pmReview: taskId(batchId, 'pm-review'),
  };

  const common = { input: { planningBatchId: batchId } };

  const threePass = usesThreePassFlow(requests);
  const featurePassTasks = !threePass ? [] : [
    {
      id: ids.featuresFunctional,
      stage: 'tech_lead',
      ...common,
      input: {
        ...common.input,
        purpose: 'PLANNER_FEATURES_FUNCTIONAL',
        phase: 'functional',
        requests: structuredClone(requests),
      },
    },
    {
      id: ids.validateFunctional,
      stage: 'plan_validator',
      dependsOn: [ids.featuresFunctional],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_VALIDATE_FEATURES', phase: 'functional' },
    },
    {
      id: ids.criticFunctional,
      stage: 'tech_lead_critic',
      dependsOn: [ids.validateFunctional],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_CRITIC_FEATURES', phase: 'functional' },
    },
    {
      id: ids.repairFunctional,
      stage: 'tech_lead',
      dependsOn: [ids.criticFunctional],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_REPAIR_FEATURES', phase: 'functional' },
    },
    {
      id: ids.featuresNonfunctional,
      stage: 'tech_lead',
      dependsOn: [ids.repairFunctional],
      ...common,
      input: {
        ...common.input,
        purpose: 'PLANNER_FEATURES_NONFUNCTIONAL',
        phase: 'nonfunctional',
        requests: structuredClone(requests),
      },
    },
    {
      id: ids.validateNonfunctional,
      stage: 'plan_validator',
      dependsOn: [ids.featuresNonfunctional],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_VALIDATE_FEATURES', phase: 'nonfunctional' },
    },
    {
      id: ids.criticNonfunctional,
      stage: 'tech_lead_critic',
      dependsOn: [ids.validateNonfunctional],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_CRITIC_FEATURES', phase: 'nonfunctional' },
    },
    {
      id: ids.repairNonfunctional,
      stage: 'tech_lead',
      dependsOn: [ids.criticNonfunctional],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_REPAIR_FEATURES', phase: 'nonfunctional' },
    },
  ];

  // Local replan (owner decision, 2026-11-02): when a batch carries an
  // owner decision, the PM settles the requirements side FIRST - revising
  // REQUIREMENTS.md and obtaining the owner's approval when the decision
  // mandates a wording change. Decomposition depends on that task, so the
  // Tech Lead only ever plans from requirements in their approved form.
  const hasLocalReplan = requests.some(item => item?.request?.purpose === 'LOCAL_REPLAN');
  const requirementsGateTasks = hasLocalReplan ? [{
    id: ids.requirementsDelta,
    stage: 'pm',
    ...common,
    input: {
      ...common.input,
      purpose: 'LOCAL_REPLAN_REQUIREMENTS',
      requests: structuredClone(requests),
    },
  }] : [];
  const decomposeDependsOn = [
    ...(threePass ? [ids.repairNonfunctional] : []),
    ...(hasLocalReplan ? [ids.requirementsDelta] : []),
  ];

  return [
    ...featurePassTasks,
    ...requirementsGateTasks,
    {
      id: ids.decompose,
      stage: 'tech_lead',
      ...(decomposeDependsOn.length ? { dependsOn: decomposeDependsOn } : {}),
      ...common,
      input: {
        ...common.input,
        purpose: 'PLANNER_DECOMPOSE',
        ...(threePass ? { threePass: true } : {}),
        requests: structuredClone(requests),
      },
    },
    {
      id: ids.dependencies,
      stage: 'tech_lead',
      dependsOn: [ids.decompose],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_DEPENDENCIES' },
    },
    {
      id: ids.validate1,
      stage: 'plan_validator',
      dependsOn: [ids.dependencies],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_VALIDATE', round: 1 },
    },
    {
      id: ids.critic1,
      stage: 'tech_lead_critic',
      dependsOn: [ids.validate1],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_CRITIC', round: 1 },
    },
    {
      id: ids.repair1,
      stage: 'tech_lead',
      dependsOn: [ids.critic1],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_REPAIR', round: 1 },
    },
    {
      id: ids.validate2,
      stage: 'plan_validator',
      dependsOn: [ids.repair1],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_VALIDATE', round: 2 },
    },
    {
      id: ids.critic2,
      stage: 'tech_lead_critic',
      dependsOn: [ids.validate2],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_CRITIC', round: 2 },
    },
    {
      id: ids.repair2,
      stage: 'tech_lead',
      dependsOn: [ids.critic2],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_REPAIR', round: 2 },
    },
    {
      id: ids.validate3,
      stage: 'plan_validator',
      dependsOn: [ids.repair2],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_VALIDATE', round: 3 },
    },
    {
      id: ids.critic3,
      stage: 'tech_lead_critic',
      dependsOn: [ids.validate3],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_CRITIC', round: 3 },
    },
    {
      id: ids.repair3,
      stage: 'tech_lead',
      dependsOn: [ids.critic3],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_REPAIR', round: 3 },
    },
    {
      id: ids.finalValidate,
      stage: 'plan_validator',
      dependsOn: [ids.repair3],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_FINAL_VALIDATE' },
    },
    {
      id: ids.pmReview,
      stage: 'pm',
      dependsOn: [ids.finalValidate],
      ...common,
      input: { ...common.input, purpose: 'PLANNER_PM_REVIEW' },
    },
  ];
}

export function createNextPlanningBatch({ store, projectId }) {
  const claimed = store.listClaimedPlanningBatches(projectId);
  if (claimed.length > 0) return { batchId: claimed[0], existing: true };

  const pending = store.listPlanningRequests(projectId, { states: ['PENDING'] });
  if (pending.length === 0) return null;

  const first = pending[0].sequence;
  const last = pending[pending.length - 1].sequence;
  const batchId = `batch-${first}-${last}`;
  const requestSnapshot = pending.map(item => ({
    id: item.id,
    sequence: item.sequence,
    createdAt: item.createdAt,
    request: structuredClone(item.request),
    context: structuredClone(item.context),
  }));

  return store.createPlanningBatch({
    projectId,
    batchId,
    requestIds: pending.map(item => item.id),
    tasks: plannerFlowTasks(batchId, requestSnapshot).map(task => ({
      ...task,
      taskKind: TASK_KINDS.PLANNING,
    })),
  });
}

export function isPlannerTask(task) {
  // A planner task is a PLANNING-kind task belonging to a planner batch.
  // Other PLANNING-kind tasks (debug flows, ad-hoc control flows) are
  // ordinary control tasks for scheduling purposes.
  return task?.taskKind === TASK_KINDS.PLANNING
    && typeof task.flowId === 'string'
    && task.flowId.startsWith('planner:');
}

export function plannerBatchIdFromTask(task) {
  return task?.input?.planningBatchId ?? null;
}
