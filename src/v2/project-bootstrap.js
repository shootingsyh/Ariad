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
      instruction: 'Inspect the existing repository, reconstruct the delivery tree and dependencies, and preserve valid existing work.',
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
