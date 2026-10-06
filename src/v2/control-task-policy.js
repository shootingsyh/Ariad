export const TASK_KINDS = Object.freeze({
  MILESTONE_TASK: 'MILESTONE_TASK',
  ADHOC_ANALYSIS: 'ADHOC_ANALYSIS',
  PLANNING: 'PLANNING',
  REVIEW_GATE: 'REVIEW_GATE',
  DIAGNOSTIC: 'DIAGNOSTIC',
});

const VALID = new Set(Object.values(TASK_KINDS));
const ADHOC_ISSUERS = new Set(['operator', 'user', 'pm']);
const CONTROL_ROLES = new Set(['tech_lead','tech_lead_critic','plan_validator','pm','project_debugger']);
export function effectiveTaskKind(task) {
  const kind = task?.taskKind ?? task?.input?.taskKind;
  // Existing compiled delivery ownership uses feature/integration as taskKind.
  // These are valid milestone implementation subtypes, not control task kinds.
  if (kind === 'feature' || kind === 'integration') return TASK_KINDS.MILESTONE_TASK;
  if (kind != null) return kind;
  // Historical tasks continue to use their original shape.
  return task?.scope === 'control'
    ? (task?.stage === 'project_debugger' ? TASK_KINDS.DIAGNOSTIC : TASK_KINDS.PLANNING)
    : TASK_KINDS.MILESTONE_TASK;
}
export function controlTaskPolicyFailure(task) {
  const kind = effectiveTaskKind(task);
  if (!VALID.has(kind)) return 'UNKNOWN_TASK_KIND';
  if (task.scope === 'delivery') {
    return kind === TASK_KINDS.MILESTONE_TASK ? null : 'NON_DELIVERY_TASK_IN_DELIVERY';
  }
  if (task.scope !== 'control') return 'INVALID_TASK_SCOPE';
  if (kind === TASK_KINDS.MILESTONE_TASK) return 'MILESTONE_TASK_REQUIRES_DELIVERY';
  if (kind === TASK_KINDS.ADHOC_ANALYSIS) {
    if (task.stage !== 'tech_lead') return 'ADHOC_ANALYSIS_REQUIRES_TECH_LEAD';
    if (!String(task.flowId ?? '').startsWith('adhoc:')) return 'ADHOC_ANALYSIS_REQUIRES_ADHOC_FLOW';
    if (!ADHOC_ISSUERS.has(task.input?.requestedBy)) return 'ADHOC_ANALYSIS_UNAUTHORIZED_ISSUER';
    if (!String(task.input?.instruction ?? '').trim()) return 'ADHOC_ANALYSIS_REQUIRES_INSTRUCTION';
    return null;
  }
  if (!CONTROL_ROLES.has(task.stage)) return 'CONTROL_TASK_INVALID_ROLE';
  if (kind === TASK_KINDS.PLANNING && task.taskKind === TASK_KINDS.PLANNING && !String(task.flowId ?? '').startsWith('planner:')) return 'PLANNING_REQUIRES_PLANNER_FLOW';
  if (kind === TASK_KINDS.REVIEW_GATE && task.stage !== 'pm') return 'REVIEW_GATE_REQUIRES_PM';
  if (kind === TASK_KINDS.DIAGNOSTIC && task.stage !== 'project_debugger') return 'DIAGNOSTIC_REQUIRES_DEBUGGER';
  return null;
}
export function isAdhocAnalysis(task) {
  return task?.scope === 'control' && effectiveTaskKind(task) === TASK_KINDS.ADHOC_ANALYSIS;
}
