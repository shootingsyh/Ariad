import { effectiveTaskKind, TASK_KINDS } from './control-task-policy.js';
import { executorTransitionFromResult } from './role-executor-transition.js';
import { acceptanceCriterionIds } from './acceptance.js';

// Milestone owns role transitions. Never interpret a failed or unknown result
// as PASS. Tester evidence and reviewer source-control checks remain enforced
// by their respective role-result producer and afterPersist hooks.
function failureCount(task) {
  let count = 0;
  for (let i = (task.history ?? []).length - 1; i >= 0; i--) {
    const entry = task.history[i];
    if (entry?.type !== 'ROLE_RESULT') continue;
    if (entry.role === 'project_debugger' && entry.outcome === 'WRONG_IMPLEMENTATION_APPROACH') break;
    if (['tester', 'reviewer', 'ux_reviewer'].includes(entry.role) && entry.outcome === 'NOT_PASS') count++;
  }
  return count;
}

function consecutiveRoleFailures(task, role) {
  let count = 0;
  for (let i = (task.history ?? []).length - 1; i >= 0; i--) {
    const entry = task.history[i];
    if (entry?.type !== 'ROLE_RESULT') continue;
    if (entry.role === role && entry.outcome !== 'PASS') count++;
    else if (entry.role === role && entry.outcome === 'PASS') break;
    else if (entry.role === 'project_debugger') break;
  }
  return count;
}

function validTestPlan(task, result) {
  const cases = result.result?.testPlan?.testCases;
  const criteria = acceptanceCriterionIds(task);
  return Array.isArray(cases) && cases.length > 0
    && cases.every(c => c && typeof c.entry === 'string' && c.entry.length > 0
      && typeof c.command === 'string' && c.command.length > 0
      && Array.isArray(c.covers) && Array.isArray(c.executionScope))
    && criteria.every(id => cases.some(c => c.covers.includes(id)));
}

export function milestoneResultTransition(task, result, { uxReviewEnabled = false } = {}) {
  if (effectiveTaskKind(task) !== TASK_KINDS.MILESTONE_TASK) return null;
  const outcome = result?.outcome;
  let signal;
  switch (task.stage) {
    case 'developer':
      signal = outcome === 'PASS' ? 'PASS'
        : consecutiveRoleFailures(task, 'developer') >= 3 ? 'ESCALATE' : 'RETRY';
      break;
    case 'test_engineer':
      signal = outcome === 'PASS'
        ? (validTestPlan(task, result) ? 'PASS' : 'ESCALATE')
        : (failureCount(task) >= 3 ? 'ESCALATE' : 'RETRY');
      break;
    case 'tester':
      signal = outcome === 'PASS' ? 'PASS'
        : outcome === 'NOT_PASS' && result.result?.testPlanInvalid === true ? 'REPLAN_TESTS'
        : outcome === 'NOT_PASS' && failureCount(task) < 3 ? 'RETRY' : 'ESCALATE';
      break;
    case 'reviewer':
      signal = outcome === 'PASS'
        ? (uxReviewEnabled && task.ux?.required === true ? 'UX_REVIEW' : 'PASS')
        : outcome === 'NOT_PASS' && failureCount(task) < 3 ? 'RETRY' : 'ESCALATE';
      break;
    case 'ux_reviewer':
      signal = outcome === 'PASS' ? 'PASS'
        : outcome === 'NOT_PASS' && failureCount(task) < 3 ? 'RETRY' : 'ESCALATE';
      break;
    case 'project_debugger': {
      // A separate diagnostic task may need to mutate its blocked task.
      // Replanning also enqueues work. Preserve those side effects until
      // they are migrated into an atomic executor operation.
      if (task.input?.blockedTaskId || outcome === 'TASK_TOO_LARGE') return null;
      if (outcome === 'WRONG_IMPLEMENTATION_APPROACH') signal = 'REPAIRED';
      else if (outcome === 'ASSET_ISSUE') signal = 'ROUTE_ARTIST';
      else if (['REQUIREMENT_DECISION_REQUIRED', 'UNKNOWN_PROJECT_CAUSE'].includes(outcome)) signal = 'ROUTE_PM';
      else if (['SYSTEM_RUNTIME_FAILURE', 'MODEL_CAPABILITY_MISMATCH'].includes(outcome)) signal = 'NEEDS_HUMAN';
      else return null;
      const transition = executorTransitionFromResult(task, signal);
      const route = { REPAIRED: 'developer', ROUTE_ARTIST: 'artist', ROUTE_PM: 'pm' }[signal];
      return {
        ...transition.patch,
        transitionHistory: signal === 'NEEDS_HUMAN' ? {
          type: 'SYSTEM_DIAGNOSIS', role: 'project_debugger', blockedTaskId: null,
          diagnosis: outcome, summary: result.summary ?? result.result?.reason ?? 'Execution failure requires operator action.',
          evidence: result.result?.evidence ?? [],
          affectedComponent: result.result?.affectedComponent ?? null,
          guidance: result.result?.guidance ?? null,
          questions: ['Review the diagnosis, repair the runtime/model policy as appropriate, then explicitly resume the project.'],
          at: new Date().toISOString(),
        } : {
          type: 'DEBUGGER_ROUTE', role: 'project_debugger', route,
          diagnosis: outcome, guidance: result.result?.guidance ?? null,
          ...(route === 'pm' ? { summary: result.summary ?? result.result?.reason ?? null } : {}),
          at: new Date().toISOString(),
        },
      };
    }
    default:
      // Debugger's product/requirement decisions require the existing explicit
      // PM/TL routing; do not invent a generic automatic repair verdict.
      return null;
  }
  return executorTransitionFromResult(task, signal)?.patch ?? null;
}
