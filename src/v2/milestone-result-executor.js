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
  const kind = effectiveTaskKind(task);
  const diagnostic = kind === TASK_KINDS.DIAGNOSTIC && task.stage === 'project_debugger';
  if (kind !== TASK_KINDS.MILESTONE_TASK && !diagnostic) return null;
  // Planner-frontier diagnostics have a distinct control protocol.
  if (diagnostic && task.input?.purpose === 'PLANNER_FRONTIER_DEBUG') return null;
  const outcome = result?.outcome;
  let signal;
  switch (task.stage) {
    case 'developer':
      signal = outcome === 'PASS' ? 'PASS'
        : outcome === 'NOT_PASS' && consecutiveRoleFailures(task, 'developer') < 3 ? 'RETRY' : 'ESCALATE';
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
      if (outcome === 'TASK_TOO_LARGE') {
        const blockedTaskId = task.input?.blockedTaskId ?? null;
        const targetTaskId = blockedTaskId ?? task.id;
        const history = {
          type: 'DEBUGGER_ROUTE', role: 'project_debugger', route: 'tech_lead',
          diagnosis: outcome, guidance: result.result?.guidance ?? null,
          ...(blockedTaskId ? { source: 'system_block_diagnosis' } : {}),
          at: new Date().toISOString(),
        };
        return {
          ...(blockedTaskId ? { state: 'DONE', blockedRoute: {
            taskId: blockedTaskId,
            patch: { stage: 'developer', state: 'WAITING_REPLAN', execution: null },
            history,
          } } : { state: 'WAITING_REPLAN', stage: 'developer' }),
          planningRequest: {
            id: 'debugger-replan:' + task.id + ':' + task.version,
            request: { purpose: 'REPLAN_TASK', taskId: targetTaskId, diagnosis: result.result ?? result },
          },
          transitionHistory: blockedTaskId ? null : history,
        };
      }
      if (outcome === 'WRONG_IMPLEMENTATION_APPROACH') signal = 'REPAIRED';
      else if (outcome === 'ASSET_ISSUE') signal = 'ROUTE_ARTIST';
      else if (['REQUIREMENT_DECISION_REQUIRED', 'UNKNOWN_PROJECT_CAUSE'].includes(outcome)) signal = 'ROUTE_PM';
      else if (['SYSTEM_RUNTIME_FAILURE', 'MODEL_CAPABILITY_MISMATCH'].includes(outcome)) signal = 'NEEDS_HUMAN';
      else signal = 'ROUTE_PM';
      const transition = executorTransitionFromResult(diagnostic
        ? { ...task, taskKind: TASK_KINDS.MILESTONE_TASK, scope: 'delivery' } : task, signal);
      const route = { REPAIRED: 'developer', ROUTE_ARTIST: 'artist', ROUTE_PM: 'pm' }[signal];
      const blockedTaskId = task.input?.blockedTaskId ?? null;
      const blockedRoute = blockedTaskId && route ? {
        taskId: blockedTaskId,
        patch: { stage: route, state: 'READY', execution: null },
        history: {
          type: 'DEBUGGER_ROUTE', role: 'project_debugger', route,
          diagnosis: outcome ?? 'UNKNOWN', guidance: result.result?.guidance ?? null,
          source: 'system_block_diagnosis', at: new Date().toISOString(),
        },
      } : null;
      return {
        ...(blockedRoute ? { state: 'DONE', blockedRoute } : transition.patch),
        transitionHistory: signal === 'NEEDS_HUMAN' ? {
          type: 'SYSTEM_DIAGNOSIS', role: 'project_debugger', blockedTaskId,
          diagnosis: outcome, summary: result.summary ?? result.result?.reason ?? 'Execution failure requires operator action.',
          evidence: result.result?.evidence ?? [],
          affectedComponent: result.result?.affectedComponent ?? null,
          guidance: result.result?.guidance ?? null,
          questions: ['Review the diagnosis, repair the runtime/model policy as appropriate, then explicitly resume the project.'],
          at: new Date().toISOString(),
        } : {
          type: 'DEBUGGER_ROUTE', role: 'project_debugger', route,
          diagnosis: outcome ?? 'UNKNOWN', guidance: result.result?.guidance ?? null,
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
