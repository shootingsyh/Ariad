import { executorTransitionFromResult } from './role-executor-transition.js';

// Sub-plan outcome policy belongs to the executor, not Scheduler or role
// implementations. Every stage change is resolved by the declared DSL.
export function subPlanResultTransition(task, result) {
  if (!['NODE_PLANNING', 'GLOBAL_REVIEW'].includes(task.taskKind)) return null;
  const input = task.input ?? {};
  const stages = input.stages ?? [];
  const retries = input.workflowRetries ?? 0;
  const previousGateFailure = {
    stage: task.stage, outcome: result.outcome, details: result.result ?? null,
  };
  let signal, patch = {}, transitionHistory = null;
  if (task.stage === 'project_debugger') {
    const guidance = result.result?.guidance;
    const repaired = result.outcome === 'RETRY_WITH_GUIDANCE'
      && typeof guidance === 'string' && Boolean(guidance.trim())
      && (input.debuggerRecoveryCount ?? 0) < 1;
    signal = repaired ? 'REPAIRED' : 'NEEDS_HUMAN';
    if (repaired) {
      patch.input = {
        ...input, workflowRetries: 0, debuggerRecoveryCount: 1,
        previousGateFailure: { ...input.previousGateFailure, debuggerGuidance: guidance.trim() },
      };
      transitionHistory = { type: 'WORKFLOW_DEBUGGER_RECOVERY', at: new Date().toISOString() };
    } else {
      transitionHistory = {
        type: 'WORKFLOW_DEBUGGER_DIAGNOSIS', outcome: result.outcome,
        guidance: guidance ?? result.summary ?? null, at: new Date().toISOString(),
      };
    }
  } else {
    if (!stages.includes(task.stage)
      && !(task.taskKind === 'GLOBAL_REVIEW' && task.stage === 'tech_lead' && retries > 0)) {
      throw new Error('WORKFLOW_STAGE_MISMATCH');
    }
    const allowed = task.stage === 'tech_lead' ? ['PLANNED', 'REPLANNED']
      : task.stage === 'tech_lead_critic' ? ['CLEAN', 'MINOR_ONLY'] : ['PASS'];
    if (!allowed.includes(result.outcome)) {
      signal = retries < 2 ? 'RETRY' : 'ESCALATE';
      patch.input = {
        ...input, workflowRetries: retries < 2 ? retries + 1 : retries,
        previousGateFailure,
      };
      if (signal === 'ESCALATE') {
        transitionHistory = { type: 'WORKFLOW_DEBUGGER_ROUTED', attempts: retries, at: new Date().toISOString() };
      }
    } else if (task.stage === 'plan_validator' && !stages.includes('tech_lead_critic')) {
      signal = 'SKIP_CRITIC';
    } else if (task.stage === 'tech_lead' && task.taskKind === 'GLOBAL_REVIEW') {
      // Global review begins at validator; TL is only a repair stage.
      signal = 'PASS';
    } else {
      signal = 'PASS';
    }
  }
  const transition = executorTransitionFromResult(task, signal);
  if (!transition) throw new Error('SUB_PLAN_EXECUTOR_BINDING_MISSING');
  // Global review can enter validator directly; retries re-enter TL through
  // the same declared PLAN state, without a hidden transition.
  return {
    ...transition.patch, ...patch,
    ...(transitionHistory ? { transitionHistory } : {}),
  };
}
