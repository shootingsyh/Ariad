import { advanceDurablePlanningWorkflow } from './durable-planning-workflow-executor.js';

// Stable legacy entrypoint; all planning workflows use the new executor.
export function advanceNodePlanningWorkflows(store, projectId) {
  const parents = store.listTasks(projectId, { scope: 'control' }).filter(task =>
    task.taskKind === 'WORKFLOW' && task.state === 'READY');
  for (const parent of parents) advanceDurablePlanningWorkflow(store, parent);
}

export function workflowChildTransition(task, result) {
  if (!['NODE_PLANNING', 'GLOBAL_REVIEW'].includes(task.taskKind)) return null;
  if (task.stage === 'project_debugger') {
    const guidance = result.result?.guidance;
    if (result.outcome === 'RETRY_WITH_GUIDANCE' && typeof guidance === 'string' && guidance.trim() && (task.input?.debuggerRecoveryCount ?? 0) < 1) {
      return { state: 'READY', stage: 'tech_lead', input: { ...task.input, workflowRetries: task.taskKind === 'GLOBAL_REVIEW' ? 1 : 0, debuggerRecoveryCount: 1, previousGateFailure: { ...task.input.previousGateFailure, debuggerGuidance: guidance.trim() } }, transitionHistory: { type: 'WORKFLOW_DEBUGGER_RECOVERY', at: new Date().toISOString() } };
    }
    return { state: 'NEEDS_HUMAN', transitionHistory: { type: 'WORKFLOW_DEBUGGER_DIAGNOSIS', outcome: result.outcome, guidance: guidance ?? result.summary ?? null, at: new Date().toISOString() } };
  }
  const stages = task.input?.stages ?? [];
  const index = stages.indexOf(task.stage);
  if (index < 0 && !(task.taskKind === 'GLOBAL_REVIEW' && task.stage === 'tech_lead' && (task.input?.workflowRetries ?? 0) > 0)) throw new Error('WORKFLOW_STAGE_MISMATCH');
  const allowed = task.stage === 'tech_lead' ? ['PLANNED', 'REPLANNED'] : task.stage === 'tech_lead_critic' ? ['CLEAN', 'MINOR_ONLY'] : ['PASS'];
  const passed = allowed.includes(result.outcome);
  if (!passed) {
    const retries = task.input?.workflowRetries ?? 0;
    if (retries < 2) return { state: 'READY', stage: 'tech_lead', input: { ...task.input, workflowRetries: retries + 1, previousGateFailure: { stage: task.stage, outcome: result.outcome, details: result.result ?? null } } };
    return { state: 'READY', stage: 'project_debugger', input: { ...task.input, previousGateFailure: { stage: task.stage, outcome: result.outcome, details: result.result ?? null } }, transitionHistory: { type: 'WORKFLOW_DEBUGGER_ROUTED', attempts: retries, at: new Date().toISOString() } };
  }
  if (task.taskKind === 'GLOBAL_REVIEW' && task.stage === 'tech_lead') return { state: 'READY', stage: 'plan_validator' };
  return index + 1 < stages.length ? { state: 'READY', stage: stages[index + 1] } : { state: 'DONE' };
}
