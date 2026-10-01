export function buildDurableRuntimeStatus(store, projectId) {
  const tasks = store.listTasks(projectId);
  const planning = store.listPlanningRequests(projectId);
  const project = store.getProject(projectId);
  return {
    deliveryEnabled: project?.deliveryEnabled === true,
    projectVersion: project?.projectVersion ?? 0,
    activeVersion: project?.activeVersion ?? 1,
    versionHistory: project?.versionHistory ?? [],
    tasks: {
      total: tasks.length,
      working: tasks.filter(task => task.state === 'WORKING').length,
      ready: tasks.filter(task => task.state === 'READY').length,
      needsHuman: tasks.filter(task => task.state === 'NEEDS_HUMAN').length,
      done: tasks.filter(task => task.state === 'DONE').length,
    },
    planning: {
      pending: planning.filter(item => item.state === 'PENDING').length,
      claimed: planning.filter(item => item.state === 'CLAIMED').length,
      planned: planning.filter(item => item.state === 'PLANNED').length,
    },
    activeTasks: tasks
      .filter(task => !['DONE', 'SKIPPED', 'OBSOLETE'].includes(task.state))
      .map(task => {
        const interruption = [...(task.history ?? [])].reverse().find(entry => entry?.type === 'SYSTEM_INTERRUPTION');
        return {
          id: task.id,
          stage: task.stage,
          state: task.state,
          ...(interruption?.failure ? { lastSystemFailure: interruption.failure } : {}),
        };
      }),
    humanDecisions: tasks
      .filter(task => task.state === 'NEEDS_HUMAN')
      .map(task => {
        const history = task.history ?? [];
        const roleResult = [...history].reverse().find(entry => entry?.type === 'ROLE_RESULT');
        const decisionContext = [...history].reverse().find(entry =>
          entry?.type !== 'ROLE_RESULT'
          && entry?.type !== 'SYSTEM_INTERRUPTION'
          && entry?.type !== 'SYSTEM_RECOVERY'
        );
        return {
          taskId: task.id,
          stage: task.stage,
          title: task.title ?? task.input?.title ?? null,
          summary: decisionContext?.summary ?? roleResult?.summary ?? null,
          questions: decisionContext?.questions ?? roleResult?.result?.questions ?? [],
          guidance: decisionContext?.guidance ?? roleResult?.result?.guidance ?? null,
          outcome: roleResult?.outcome ?? null,
          result: roleResult?.result ?? null,
        };
      }),
  };
}
