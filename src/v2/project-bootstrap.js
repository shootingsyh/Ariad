export function bootstrapProject({ store, projectId, directoryEmpty, flowId = `bootstrap:${projectId}` }) {
  if (!store || typeof store.createControlFlow !== 'function') throw new Error('bootstrapProject requires store');
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
      controlFlow: null,
    };
  }

  const tasks = store.createControlFlow({
    projectId,
    flowId,
    tasks: [
      {
        id: `${flowId}:restore`,
        stage: 'tech_lead',
        input: { purpose: 'RESTORE_PROJECT_STATE' },
      },
      {
        id: `${flowId}:review`,
        stage: 'pm',
        dependsOn: [`${flowId}:restore`],
        input: { purpose: 'REVIEW_RESTORED_PROJECT_STATE' },
      },
    ],
  });

  return {
    pmInvocation: {
      role: 'pm',
      kind: 'WELCOME_AND_RESTORE_STARTED',
      projectId,
      sessionKey: project.pmBinding ?? projectId,
      flowId,
    },
    controlFlow: { flowId, tasks },
  };
}

export function createPlanningFlow({ store, projectId, flowId, kind = 'plan', input = {} }) {
  if (!['plan', 'replan'].includes(kind)) throw new Error(`unsupported planning flow kind: ${kind}`);
  const prefix = flowId ?? `${kind}:${Date.now()}`;
  const tasks = store.createControlFlow({
    projectId,
    flowId: prefix,
    tasks: [
      {
        id: `${prefix}:tl`,
        stage: 'tech_lead',
        input: { purpose: kind === 'plan' ? 'PLAN' : 'REPLAN', ...structuredClone(input) },
      },
      {
        id: `${prefix}:pm-review`,
        stage: 'pm',
        dependsOn: [`${prefix}:tl`],
        input: { purpose: 'PLAN_REVIEW' },
      },
    ],
  });
  return { flowId: prefix, tasks };
}
