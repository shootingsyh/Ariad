import test from 'node:test';
import assert from 'node:assert/strict';
import { planningTraversalMachine as machine } from '../src/v2/planning-traversal-machine.js';
import { readWorkflowExecutorCheckpoint, persistWorkflowExecutorSignal, persistWorkflowSpawn } from '../src/v2/workflow-executor-checkpoint.js';

function fixture() {
  let task = { id: 'parent', projectId: 'P', taskKind: 'WORKFLOW',
    version: 1, workflowState: { cursor: 2, completedNodes: ['one'] } };
  const store = {
    getTask: () => structuredClone(task),
    updateTask(id, version, patch) {
      if (version !== task.version) throw new Error('task version conflict');
      task = { ...task, ...structuredClone(patch), version: task.version + 1 };
      return structuredClone(task);
    },
    advanceNodePlanningWorkflow({ expectedVersion, childTask, workflowState }) {
      if (expectedVersion !== task.version) throw new Error('WORKFLOW_VERSION_CONFLICT');
      task = { ...task, workflowState: structuredClone(workflowState), version: task.version + 1 };
      return { parent: structuredClone(task), child: childTask };
    },
  };
  return { store };
}

test('checkpoint reuses workflowState and preserves legacy cursor', () => {
  const { store } = fixture();
  assert.equal(readWorkflowExecutorCheckpoint(store.getTask(), machine).state, 'TRAVERSE');
  persistWorkflowExecutorSignal({ store, taskId: 'parent', machine, signal: 'NODE_FOUND' });
  const task = store.getTask();
  assert.equal(task.workflowState.cursor, 2);
  assert.deepEqual(task.workflowState.completedNodes, ['one']);
  assert.equal(task.workflowState.executor.state, 'SPAWN');
});

test('spawn and WAIT_CHILD checkpoint share one store transaction', () => {
  const { store } = fixture();
  persistWorkflowExecutorSignal({ store, taskId: 'parent', machine, signal: 'NODE_FOUND' });
  const result = persistWorkflowSpawn({ store, taskId: 'parent', machine,
    childTask: { id: 'child' }, workflowState: { cursor: 3, activeChildTaskId: 'child' } });
  assert.equal(result.parent.workflowState.executor.state, 'WAIT_CHILD');
  assert.equal(result.parent.workflowState.cursor, 3);
  assert.equal(result.parent.workflowState.activeChildTaskId, 'child');
});

test('rejects unknown signals, stale checkpoint version and premature spawn', () => {
  const { store } = fixture();
  assert.throws(() => persistWorkflowExecutorSignal({ store, taskId: 'parent', machine, signal: 'CHILD_COMPLETE' }), /unexpected signal/);
  assert.throws(() => persistWorkflowSpawn({ store, taskId: 'parent', machine, childTask: {}, workflowState: { cursor: 1 } }), /WORKFLOW_NOT_IN_SPAWN/);
  persistWorkflowExecutorSignal({ store, taskId: 'parent', machine, signal: 'NODE_FOUND' });
  const other = { ...machine, version: 2 };
  assert.throws(() => readWorkflowExecutorCheckpoint(store.getTask(), other), /VERSION_MISMATCH/);
});


test('SQLite checkpoint survives store reopen and prevents duplicate child spawn', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SQLiteV2Store } = await import('../src/v2/sqlite-store.js');
  const dir = mkdtempSync(join(tmpdir(), 'ariad-dsl-restart-'));
  const db = join(dir, 'state.db');
  let store = new SQLiteV2Store(db);
  try {
    store.createProject({ id: 'P', spec: 'restart test' });
    store.createTask({ id: 'parent', projectId: 'P', taskKind: 'WORKFLOW',
      executorType: 'node-planning', scope: 'control', flowId: 'workflow:restart',
      stage: 'tech_lead', state: 'READY', dependsOn: [],
      workflowState: { cursor: 0, completedNodes: [], activeChildTaskId: null } });
    persistWorkflowExecutorSignal({ store, taskId: 'parent', machine, signal: 'NODE_FOUND' });
    store.close();
    store = new SQLiteV2Store(db);
    assert.equal(readWorkflowExecutorCheckpoint(store.getTask('parent'), machine).state, 'SPAWN');
    const childTask = { id: 'child', projectId: 'P', scope: 'control',
      flowId: 'workflow:restart', parentTaskId: 'parent', taskKind: 'NODE_PLANNING',
      stage: 'tech_lead', state: 'READY', dependsOn: [] };
    persistWorkflowSpawn({ store, taskId: 'parent', machine, childTask,
      workflowState: { cursor: 1, activeChildTaskId: 'child' } });
    store.close();
    store = new SQLiteV2Store(db);
    const parent = store.getTask('parent');
    assert.equal(readWorkflowExecutorCheckpoint(parent, machine).state, 'WAIT_CHILD');
    assert.equal(parent.workflowState.cursor, 1);
    assert.equal(store.getTask('child').id, 'child');
    assert.throws(() => persistWorkflowSpawn({ store, taskId: 'parent', machine, childTask,
      workflowState: { cursor: 2, activeChildTaskId: 'child' } }), /WORKFLOW_NOT_IN_SPAWN/);
    assert.equal(store.listTasks('P').filter(t => t.id === 'child').length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
