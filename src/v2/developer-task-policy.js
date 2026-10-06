/**
 * Developer is a delivery implementation role, never an administrative gate.
 * Milestone ownership alone is insufficient: V2.GATE belongs to a milestone
 * but records authorization rather than implementing the game.
 */
export function isApprovalGateTask(task) {
  const milestone = String(task?.milestoneId ?? task?.input?.milestoneId ?? '');
  const kind = String(task?.taskKind ?? task?.input?.taskKind ?? '');
  return kind === 'approval_gate'
    || kind === 'human_gate'
    || /(?:^|[.])GATE$/i.test(milestone);
}

export function developerTaskPolicyFailure(task, { requireMilestone = true } = {}) {
  if (task?.stage !== 'developer') return null;
  if (task.scope !== 'delivery') return 'DEVELOPER_REQUIRES_DELIVERY_SCOPE';
  if (isApprovalGateTask(task)) return 'DEVELOPER_CANNOT_EXECUTE_APPROVAL_GATE';
  if (requireMilestone && !String(task.milestoneId ?? task.input?.milestoneId ?? '').trim()) {
    return 'DEVELOPER_REQUIRES_MILESTONE';
  }
  return null;
}
