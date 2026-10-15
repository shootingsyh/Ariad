import { subPlanResultTransition } from './sub-plan-result-executor.js';
import { adhocResultTransition } from './adhoc-result-executor.js';
import { milestoneResultTransition } from './milestone-result-executor.js';
import { isPlannerTask } from './planner-flow.js';
import { persistRoleExecutorTransition } from './role-executor-persistence.js';
import { isAdhocAnalysis } from './control-task-policy.js';

// Compatibility executor: preserve legacy role results, history, and v2 state
// semantics while removing role-specific result advancement from Scheduler.
// The new declarative executor replaces this adapter incrementally.
function latestResult(task) {
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.type === 'ROLE_RESULT' && history[i]?.role === task.stage) return history[i];
  }
  return null;
}


export class LegacyRoleResultExecutor {
  constructor({ store, roles, uxReviewEnabled = false }) {
    this.store = store;
    this.roles = roles;
    this.uxReviewEnabled = uxReviewEnabled;
  }

  async advanceResults(projectId, { migrating = false, adhocOnly = false } = {}) {
    for (const task of this.store.listTasks(projectId)) {
      if (task.state !== 'RESULT_READY') continue;
      if (adhocOnly && !isAdhocAnalysis(task)) continue;
      if (migrating && !(isPlannerTask(task) && task.input?.versionMigration === true)) continue;
      const result = latestResult(task);
      if (!result) throw new Error(`task ${task.id} is RESULT_READY without a role result`);
      const role = this.roles.get(task.stage);
      const next = subPlanResultTransition(task, result) ?? adhocResultTransition(task, result) ?? (['developer', 'test_engineer', 'tester', 'reviewer', 'ux_reviewer'].includes(task.stage) ? milestoneResultTransition(task, result, { uxReviewEnabled: this.uxReviewEnabled }) : null) ?? await role.transition({ task, result });
      await persistRoleExecutorTransition({ store: this.store, roles: this.roles, task, result, next });
    }
  }

}
