import { resolveExecutorSignal } from './executor-dsl.js';

// Reuse v2_tasks.data_json.workflowState and its existing optimistic version.
// This adapter intentionally handles *only* transitions without external effects.
// Spawning children must use store.advanceNodePlanningWorkflow(), which already
// atomically inserts the child and updates the parent.
export function readWorkflowExecutorCheckpoint(task, machine) {
  if (task.taskKind !== 'WORKFLOW') throw new Error('WORKFLOW_CHECKPOINT_REQUIRES_WORKFLOW');
  const saved = task.workflowState?.executor;
  if (!saved) {
    // Existing workflow tasks may have already spawned a child before the
    // executor migration. Resume waiting instead of spawning it twice.
    const state = task.workflowState?.activeChildTaskId ? 'WAIT_CHILD' : machine.initial;
    return { machineId: machine.id, machineVersion: machine.version, state };
  }
  if (saved.machineId !== machine.id || saved.machineVersion !== machine.version) {
    throw new Error('EXECUTOR_CHECKPOINT_VERSION_MISMATCH');
  }
  if (!Object.hasOwn(machine.states, saved.state)) throw new Error('UNKNOWN_EXECUTOR_CHECKPOINT_STATE');
  return saved;
}

export function persistWorkflowExecutorSignal({ store, taskId, machine, signal }) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('UNKNOWN_TASK');
  const checkpoint = readWorkflowExecutorCheckpoint(task, machine);
  const nextState = resolveExecutorSignal(machine, checkpoint.state, signal);
  const workflowState = {
    ...(task.workflowState ?? {}),
    executor: {
      machineId: machine.id,
      machineVersion: machine.version,
      state: nextState,
    },
  };
  // updateTask uses v2_tasks.version CAS; competing transitions cannot both
  // succeed. The next operation must not execute until this write succeeds.
  return store.updateTask(task.id, task.version, { workflowState });
}

export function persistWorkflowSpawn({
  store, taskId, machine, childTask, workflowState,
}) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('UNKNOWN_TASK');
  const checkpoint = readWorkflowExecutorCheckpoint(task, machine);
  if (checkpoint.state !== 'SPAWN') throw new Error('WORKFLOW_NOT_IN_SPAWN');
  const nextState = resolveExecutorSignal(machine, checkpoint.state, 'CREATED');
  // Store transaction atomically inserts the child and saves the cursor and
  // executor checkpoint. Caller must supply the updated traversal cursor.
  return store.advanceNodePlanningWorkflow({
    parentTaskId: task.id,
    expectedVersion: task.version,
    childTask,
    workflowState: {
      ...(task.workflowState ?? {}),
      ...workflowState,
      executor: {
        machineId: machine.id,
        machineVersion: machine.version,
        state: nextState,
      },
    },
  });
}
