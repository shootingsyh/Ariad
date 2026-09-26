export function bootstrapProject({ store, projectId, directoryEmpty, flowId = `bootstrap:${projectId}` }) {
  if (!store || typeof store.enqueuePlanningRequest !== 'function') throw new Error('bootstrapProject requires store');
  const project = store.getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  if (directoryEmpty) {
    return {
      pmInvocation: {
        role: 'pm',
        kind: 'WELCOME',
        projectId,
        sessionKey: project.pmBinding ?? projectId,
      },
      planningRequest: null,
    };
  }

  const planningRequest = store.enqueuePlanningRequest({
    id: `${flowId}:restore`,
    projectId,
    request: {
      purpose: 'RESTORE_PROJECT_STATE',
      instruction: [
        'Take over this existing repository.',
        'If durable Ariad state already exists, resume from it instead of reconstructing the project.',
        'Otherwise, first look for existing plans, roadmaps, milestone documents, architecture docs, tests, and project history and reuse them when they remain valid.',
        'Reconstruct the complete logical feature/component tree and milestone structure before delivery starts. If no reliable plan exists, infer project intent and current state from code, tests, docs, and git history.',
        'Preserve and reuse valid existing implementation and tests. Existing code is not a reason to rewrite; existing tests should be inspected, corrected/extended/removed only when needed, and then freshly rerun.',
        'Record per-task takeover findings as task history notes so Developer and Tester receive the prior context naturally.',
        'Generate/update the human-readable Ariad takeover/project documents needed to explain project intent, logical structure, milestones, architecture, test strategy, uncertainty, and the proposed next work.',
        'After reconstruction, stop for human takeover review before normal delivery proceeds.',
      ].join(' '),
    },
    context: { bootstrap: true },
  });

  return {
    pmInvocation: {
      role: 'pm',
      kind: 'WELCOME_AND_PLANNING_QUEUED',
      projectId,
      sessionKey: project.pmBinding ?? projectId,
      planningRequestId: planningRequest.id,
    },
    planningRequest,
  };
}

// Backward-compatible helper name. Plan and replan are now both planning requests;
// the Planner decides how to modify the current delivery graph from repository reality.
export function createPlanningFlow({ store, projectId, flowId, kind = 'plan', input = {} }) {
  if (!['plan', 'replan'].includes(kind)) throw new Error(`unsupported planning request kind: ${kind}`);
  const id = flowId ?? `planning:${Date.now()}`;
  const planningRequest = store.enqueuePlanningRequest({
    id,
    projectId,
    request: {
      purpose: 'UPDATE_DELIVERY_PLAN',
      ...structuredClone(input),
    },
    context: { sourceKind: kind },
  });
  return { planningRequest };
}
