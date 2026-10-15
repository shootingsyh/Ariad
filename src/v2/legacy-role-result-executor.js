import { subPlanResultTransition } from './sub-plan-result-executor.js';
import { isPlannerTask } from './planner-flow.js';
import { applyTaskEvent } from './state-machine.js';
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
  constructor({ store, roles }) {
    this.store = store;
    this.roles = roles;
  }

  async advanceResults(projectId, { migrating = false, adhocOnly = false } = {}) {
    for (const task of this.store.listTasks(projectId)) {
      if (task.state !== 'RESULT_READY') continue;
      if (adhocOnly && !isAdhocAnalysis(task)) continue;
      if (migrating && !(isPlannerTask(task) && task.input?.versionMigration === true)) continue;
      const result = latestResult(task);
      if (!result) throw new Error(`task ${task.id} is RESULT_READY without a role result`);
      const role = this.roles.get(task.stage);
      const next = subPlanResultTransition(task, result) ?? await role.transition({ task, result });
      if (!next || !next.state) throw new Error(`role ${task.stage} returned invalid transition`);
      const { skipTaskIds = [], transitionHistory = null, state: requestedState, ...patch } = next;
      const transitionEvent = ({
        READY: 'NEXT_ROLE',
        DONE: 'FINISH',
        WAITING_REPLAN: 'WAIT_REPLAN',
        NEEDS_HUMAN: 'NEED_HUMAN',
        SKIPPED: 'SKIP',
      })[requestedState];
      if (!transitionEvent) {
        throw new Error(`role ${task.stage} requested unsupported task state: ${requestedState}`);
      }
      let updated = this.store.updateTask(task.id, task.version, applyTaskEvent(
        task,
        transitionEvent,
        {
          ...patch,
          execution: null,
        },
      ));
      if (transitionHistory) {
        updated = this.store.appendTaskHistory(task.id, updated.version, transitionHistory);
      }
      for (const skipId of skipTaskIds) {
        const skipped = this.store.getTask(skipId);
        if (skipped && skipped.state === 'READY') {
          this.store.updateTask(skipId, skipped.version, { state: 'SKIPPED', execution: null });
        }
      }
      if (typeof role.afterPersist === 'function') {
        const followUp = await role.afterPersist({ task: updated, result });
        if (followUp) {
          const { patch: followUpPatch = {}, transitionHistory: followUpHistory = null } = followUp;
          updated = this.store.updateTask(updated.id, updated.version, followUpPatch);
          if (followUpHistory) {
            updated = this.store.appendTaskHistory(updated.id, updated.version, followUpHistory);
          }
        }
      }
    }
  }

}
