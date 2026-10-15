import { applyTaskEvent } from './state-machine.js';

// Persist executor decisions using the existing optimistic task version.
// Role session cleanup and optional follow-up hooks remain outside the DSL.
export async function persistRoleExecutorTransition({ store, roles, task, result, next }) {
  if (!next || !next.state) throw new Error(`role ${task.stage} returned invalid transition`);
  const { skipTaskIds = [], transitionHistory = null, state: requestedState, ...patch } = next;
  const event = ({
    READY: 'NEXT_ROLE', DONE: 'FINISH', WAITING_REPLAN: 'WAIT_REPLAN',
    NEEDS_HUMAN: 'NEED_HUMAN', SKIPPED: 'SKIP',
  })[requestedState];
  if (!event) throw new Error(`unsupported executor task state: ${requestedState}`);
  let updated = store.updateTask(task.id, task.version, applyTaskEvent(task, event, {
    ...patch, execution: null,
  }));
  if (transitionHistory) {
    updated = store.appendTaskHistory(task.id, updated.version, transitionHistory);
  }
  for (const id of skipTaskIds) {
    const skipped = store.getTask(id);
    if (skipped?.state === 'READY') {
      store.updateTask(id, skipped.version, { state: 'SKIPPED', execution: null });
    }
  }
  const role = roles.get(task.stage);
  if (typeof role.afterPersist === 'function') {
    const followUp = await role.afterPersist({ task: updated, result });
    if (followUp) {
      const { patch: followUpPatch = {}, transitionHistory: followUpHistory = null } = followUp;
      updated = store.updateTask(updated.id, updated.version, followUpPatch);
      if (followUpHistory) {
        updated = store.appendTaskHistory(updated.id, updated.version, followUpHistory);
      }
    }
  }
  return updated;
}
