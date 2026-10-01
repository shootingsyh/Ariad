export function restartOrphanEvidence(task) {
  if (task?.state !== 'NEEDS_HUMAN' || task?.stage !== 'project_debugger') return null;
  const history = task.history ?? [];
  const latestRoleResult = [...history]
    .reverse()
    .find(entry => entry?.type === 'ROLE_RESULT');
  const restartOrphan = [...history]
    .reverse()
    .find(entry =>
      entry?.type === 'SYSTEM_INTERRUPTION'
      && (
        entry?.failure === 'AGENT_SESSION_RUN_NOT_FOUND'
        || entry?.restartOrphan === true
      )
    );
  if (
    latestRoleResult?.role !== 'project_debugger'
    || latestRoleResult?.outcome !== 'UNKNOWN_PROJECT_CAUSE'
    || !restartOrphan
  ) return null;
  return { latestRoleResult, restartOrphan };
}

export function isRestartOrphanHumanGate(task) {
  return Boolean(restartOrphanEvidence(task));
}
