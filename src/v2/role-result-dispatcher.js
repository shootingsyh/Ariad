import { subPlanResultTransition } from './sub-plan-result-executor.js';
import { adhocResultTransition } from './adhoc-result-executor.js';
import { milestoneResultTransition } from './milestone-result-executor.js';
import { persistRoleExecutorTransition } from './role-executor-persistence.js';
import { isAdhocAnalysis, TASK_KINDS } from './control-task-policy.js';

// Result advancement is dispatched by the task's single type field. Kinds
// with a dedicated executor machine resolve through it; every other kind
// (PLANNING, REVIEW_GATE, WORKFLOW, ...) advances through its role's
// transition, which for planner roles is itself DSL-backed. A dedicated
// executor may decline (null), in which case the role transition is the
// fallback — the same contract the old try-chain had, made explicit.
async function fallbackTransition(role, task, result) {
  if (typeof role.transition !== 'function') {
    throw new Error(`ROLE_TRANSITION_UNAVAILABLE:${task.stage}`);
  }
  return role.transition({ task, result });
}

function latestResult(task) {
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.type === 'ROLE_RESULT' && history[i]?.role === task.stage) return history[i];
  }
  return null;
}

const DELIVERY_RESULT_STAGES = new Set([
  'developer', 'test_engineer', 'tester', 'reviewer', 'ux_reviewer', 'project_debugger',
]);

export class RoleResultDispatcher {
  constructor({ store, roles, uxReviewEnabled = false }) {
    this.store = store;
    this.roles = roles;
    this.uxReviewEnabled = uxReviewEnabled;
  }

  #dispatchTable() {
    const milestone = (task, result, role) => (DELIVERY_RESULT_STAGES.has(task.stage)
      ? milestoneResultTransition(task, result, {
        uxReviewEnabled: this.uxReviewEnabled
          || (this.roles.roles?.get('reviewer')?.uxReviewEnabled === true
            || (!this.roles.roles && role.uxReviewEnabled === true)),
      })
      : null);
    return {
      [TASK_KINDS.NODE_PLANNING]: (task, result) => subPlanResultTransition(task, result),
      [TASK_KINDS.GLOBAL_REVIEW]: (task, result) => subPlanResultTransition(task, result),
      [TASK_KINDS.ADHOC_ANALYSIS]: (task, result) => adhocResultTransition(task, result),
      [TASK_KINDS.MILESTONE_TASK]: milestone,
      [TASK_KINDS.FEATURE_TASK]: milestone,
      [TASK_KINDS.INTEGRATION_TASK]: milestone,
      [TASK_KINDS.DIAGNOSTIC]: milestone,
    };
  }

  async advanceResults(projectId, { adhocOnly = false } = {}) {
    const table = this.#dispatchTable();
    for (const task of this.store.listTasks(projectId)) {
      if (task.state !== 'RESULT_READY') continue;
      if (adhocOnly && !isAdhocAnalysis(task)) continue;
      const result = latestResult(task);
      if (!result) throw new Error(`task ${task.id} is RESULT_READY without a role result`);
      const role = this.roles.get(task.stage);
      const entry = table[task.taskKind];
      const next = (entry ? entry(task, result, role) : null)
        ?? await fallbackTransition(role, task, result);
      await persistRoleExecutorTransition({ store: this.store, roles: this.roles, task, result, next });
    }
  }
}
