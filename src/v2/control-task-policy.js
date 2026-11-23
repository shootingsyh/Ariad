export const TASK_KINDS = Object.freeze({
  MILESTONE_TASK: 'MILESTONE_TASK',
  ADHOC_ANALYSIS: 'ADHOC_ANALYSIS',
  WORKFLOW: 'WORKFLOW',
  NODE_PLANNING: 'NODE_PLANNING',
  GLOBAL_REVIEW: 'GLOBAL_REVIEW',
  PLANNING: 'PLANNING',
  REVIEW_GATE: 'REVIEW_GATE',
  DIAGNOSTIC: 'DIAGNOSTIC',
  FEATURE_TASK: 'FEATURE_TASK',
  INTEGRATION_TASK: 'INTEGRATION_TASK',
});

export const DELIVERY_KINDS = Object.freeze([
  TASK_KINDS.MILESTONE_TASK, TASK_KINDS.FEATURE_TASK, TASK_KINDS.INTEGRATION_TASK,
]);
export function isDeliveryKind(kind) {
  return DELIVERY_KINDS.includes(kind);
}

const VALID = new Set(Object.values(TASK_KINDS));
const ADHOC_ISSUERS = new Set(['operator', 'user', 'pm']);
const CONTROL_ROLES = new Set(['tech_lead','tech_lead_critic','plan_validator','pm','project_debugger']);
export function controlTaskPolicyFailure(task) {
  const kind = task?.taskKind;
  if (!VALID.has(kind)) return 'UNKNOWN_TASK_KIND';
  if (isDeliveryKind(kind)) return null;
  if (kind === TASK_KINDS.WORKFLOW) {
    if (!String(task.flowId ?? '').startsWith('workflow:')) return 'WORKFLOW_REQUIRES_WORKFLOW_FLOW';
    return null;
  }
  if (kind === TASK_KINDS.NODE_PLANNING || kind === TASK_KINDS.GLOBAL_REVIEW) {
    if (!task.parentTaskId || !String(task.flowId ?? '').startsWith('workflow:')) return 'WORKFLOW_CHILD_REQUIRES_PARENT';
    const allowed = ['tech_lead', 'plan_validator', 'tech_lead_critic', 'project_debugger'];
    if (!allowed.includes(task.stage)) return 'WORKFLOW_CHILD_INVALID_STAGE';
    return null;
  }
  if (kind === TASK_KINDS.ADHOC_ANALYSIS) {
    if (task.stage !== 'tech_lead') return 'ADHOC_ANALYSIS_REQUIRES_TECH_LEAD';
    if (!String(task.flowId ?? '').startsWith('adhoc:')) return 'ADHOC_ANALYSIS_REQUIRES_ADHOC_FLOW';
    if (!ADHOC_ISSUERS.has(task.input?.requestedBy)) return 'ADHOC_ANALYSIS_UNAUTHORIZED_ISSUER';
    if (!String(task.input?.instruction ?? '').trim()) return 'ADHOC_ANALYSIS_REQUIRES_INSTRUCTION';
    return null;
  }
  if (!CONTROL_ROLES.has(task.stage)) return 'CONTROL_TASK_INVALID_ROLE';
  if (kind === TASK_KINDS.REVIEW_GATE && task.stage !== 'pm') return 'REVIEW_GATE_REQUIRES_PM';
  if (kind === TASK_KINDS.DIAGNOSTIC && task.stage !== 'project_debugger') return 'DIAGNOSTIC_REQUIRES_DEBUGGER';
  return null;
}

export function scopeOfTask(task) {
  return isDeliveryKind(task?.taskKind) ? 'delivery' : 'control';
}

// Which SYSTEM_BLOCKED tasks the system-block diagnosis sweep serves: a
// delivery or planning task frozen by a system failure. A delivery task
// already sitting in the debugger stage is inside the debugger's own
// flow and is excluded; a planning task in that stage is the opposite -
// its in-flow debugger already delivered the terminal diagnosis that
// parked it, so the separate diagnosis is its only way back. The
// project-state derivation uses this same predicate to decide whether a
// blocked task is covered by an active diagnosis.
export function isDiagnosisEligible(task) {
  if (task?.state !== 'SYSTEM_BLOCKED') return false;
  const planning = task.taskKind === TASK_KINDS.PLANNING;
  if (!isDeliveryKind(task.taskKind) && !planning) return false;
  if (!planning && task.stage === 'project_debugger') return false;
  return true;
}

// The operator gate a system-block diagnosis leaves on the blocked task
// itself: a SYSTEM_DIAGNOSIS history entry that no HUMAN_DECISION (or
// later recovery) has answered yet. While it is open the project waits
// at NEEDS_HUMAN and the supervisor starts no new diagnosis session.
export function openDiagnosisGate(task) {
  let gate = null;
  for (const entry of task?.history ?? []) {
    if (entry?.type === 'SYSTEM_DIAGNOSIS') gate = entry;
    if (entry?.type === 'HUMAN_DECISION' || entry?.type === 'SYSTEM_RECOVERY') gate = null;
  }
  return gate;
}

// Delivery work lives in one of two parallel queues: the milestone task
// tree (default) or the standalone issue queue (triaged fixes). The
// scheduler drains the issue queue first.
export function queueOfTask(task) {
  return task?.queue ?? task?.input?.queue ?? 'milestone';
}

export function isAdhocAnalysis(task) {
  return task?.taskKind === TASK_KINDS.ADHOC_ANALYSIS;
}
