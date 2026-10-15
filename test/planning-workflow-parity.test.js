import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { advanceNodePlanningWorkflows } from '../src/v2/node-planning-workflow-executor.js';

function scenario(durable) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-planning-parity-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P' });
    const task = store.createTask({
      id: 'wf', projectId: 'P', scope: 'control', flowId: 'workflow:P:parity',
      taskKind: 'WORKFLOW', executorType: 'node-planning', stage: 'tech_lead',
      input: {
        phase: 'REPLAN', operation: 'REPLAN', rootId: 'root',
        nodes: [{ id: 'root', parentId: null, title: 'Root', children: [] }],
      },
      ...(durable ? { workflowState: { cursor: 0, completedNodes: [], activeChildTaskId: null,
        executor: { machineId: 'planning-tree-traversal', machineVersion: 1, state: 'TRAVERSE' } } } : {}),
    });
    const snapshots = [];
    for (let i = 0; i < 80; i++) {
      advanceNodePlanningWorkflows(store, 'P');
      const parent = store.getTask(task.id);
      const children = store.listTasks('P').filter(t => t.parentTaskId === task.id);
      if (children.length && children.at(-1).state === 'READY') {
        const child = children.at(-1);
        store.updateTask(child.id, child.version, { state: 'DONE' });
      }
      snapshots.push({ state: parent.state, childKinds: children.map(t => t.taskKind),
        completed: parent.workflowState?.completedNodes?.length ?? 0 });
      if (parent.state === 'DONE') break;
    }
    const final = store.getTask(task.id);
    return { state: final.state, cursor: final.workflowState.cursor,
      completed: final.workflowState.completedNodes.length,
      childKinds: store.listTasks('P').filter(t => t.parentTaskId === task.id).map(t => t.taskKind),
      snapshots };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('durable planning traversal preserves legacy externally visible outcome', () => {
  const legacy = scenario(false);
  const durable = scenario(true);
  assert.equal(legacy.state, 'DONE');
  assert.equal(durable.state, legacy.state);
  assert.equal(durable.cursor, legacy.cursor);
  assert.equal(durable.completed, legacy.completed);
  assert.deepEqual(durable.childKinds, legacy.childKinds);
  // Internal tick count intentionally differs: durable implementation
  // checkpoints each state transition before the next operation.
  assert.ok(durable.snapshots.length >= legacy.snapshots.length);
});
