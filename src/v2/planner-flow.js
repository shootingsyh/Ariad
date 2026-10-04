function taskId(batchId, name) {
  return `planner:${batchId}:${name}`;
}

function isVersionMigrationRequest(requests) {
  return requests.length === 1 && requests[0]?.request?.purpose === 'VERSION_MIGRATION';
}

function migrationFrontierFlowTasks(batchId, requests) {
  const request = requests[0]?.request ?? {};
  const phase = request.frontierPhase ?? 'feature';
  const id = name => taskId(batchId, name);
  return [
    {
      id: id('frontier-decompose'),
      stage: 'tech_lead',
      input: {
        planningBatchId: batchId,
        purpose: 'PLANNER_DECOMPOSE',
        requests: structuredClone(requests),
        frontierPhase: phase,
        singleFrontier: true,
        versionMigration: true,
      },
    },
    {
      id: id('frontier-validate-1'),
      stage: 'plan_validator',
      dependsOn: [id('frontier-decompose')],
      input: {
        planningBatchId: batchId,
        purpose: 'PLANNER_FRONTIER_VALIDATE',
        frontierPhase: phase,
        round: 1,
        versionMigration: true,
      },
    },
    {
      id: id('frontier-critic'),
      stage: 'tech_lead_critic',
      dependsOn: [id('frontier-validate-1')],
      input: {
        planningBatchId: batchId,
        purpose: 'PLANNER_FRONTIER_CRITIC',
        frontierPhase: phase,
        round: 1,
        versionMigration: true,
      },
    },
    {
      id: id('frontier-repair'),
      stage: 'tech_lead',
      dependsOn: [id('frontier-critic')],
      input: {
        planningBatchId: batchId,
        purpose: 'PLANNER_FRONTIER_REPAIR',
        frontierPhase: phase,
        versionMigration: true,
      },
    },
    {
      id: id('frontier-validate-2'),
      stage: 'plan_validator',
      dependsOn: [id('frontier-repair')],
      input: {
        planningBatchId: batchId,
        purpose: 'PLANNER_FRONTIER_VALIDATE',
        frontierPhase: phase,
        round: 2,
        versionMigration: true,
      },
    },
    {
      id: id('frontier-finalize'),
      stage: 'plan_validator',
      dependsOn: [id('frontier-critic'), id('frontier-validate-2')],
      input: {
        planningBatchId: batchId,
        purpose: 'PLANNER_FRONTIER_FINALIZE',
        frontierPhase: phase,
        versionMigration: true,
      },
    },
  ];
}

export function plannerFlowTasks(batchId, requests) {
  if (isVersionMigrationRequest(requests)) {
    return migrationFrontierFlowTasks(batchId, requests);
  }
  const ids = {
    decompose: taskId(batchId, 'decompose'),
    dependencies: taskId(batchId, 'dependencies'),
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

  return [
    {
      id: ids.decompose,
      stage: 'tech_lead',
      ...common,
      input: {
        ...common.input,
        purpose: 'PLANNER_DECOMPOSE',
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
    tasks: plannerFlowTasks(batchId, requestSnapshot),
  });
}

export function isPlannerTask(task) {
  return task?.scope === 'control'
    && typeof task.flowId === 'string'
    && task.flowId.startsWith('planner:');
}

export function plannerBatchIdFromTask(task) {
  return task?.input?.planningBatchId ?? null;
}
