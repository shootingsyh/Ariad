import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { advanceNodePlanningWorkflows, workflowChildTransition } from '../src/v2/node-planning-workflow-executor.js';

test('durable interface postorder, role steps, global review, restart and idempotency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-wf-executor-'));
  let store;
  try {
    const db = join(dir, 'state.db');
    store = new SQLiteV2Store(db);
    store.createProject({ id: 'P' });
    const parent = store.createNodePlanningWorkflow({ id: 'wf', projectId: 'P', phase: 'interface', reason: 'fix interfaces', scopeNodeId: 'root' });
    const nodes = [{ id: 'root', parentId: null }, { id: 'leaf', parentId: 'root' }];
    store.updateTask(parent.id, parent.version, { input: { ...parent.input, nodes } });
    advanceNodePlanningWorkflows(store, 'P');
    let child = store.getTask('wf:0');
    assert.equal(child.input.nodeId, 'leaf');
    assert.equal(child.stage, 'tech_lead');
    advanceNodePlanningWorkflows(store, 'P');
    assert.equal(store.listTasks('P').length, 2);
    store.close(); store = new SQLiteV2Store(db);
    child = store.getTask('wf:0');
    for (const stage of child.input.stages) {
      assert.equal(child.stage, stage);
      const next = workflowChildTransition(child, { outcome: stage === 'tech_lead' ? 'PLANNED' : 'PASS' });
      child = store.updateTask(child.id, child.version, next);
    }
    assert.equal(child.state, 'DONE');
    advanceNodePlanningWorkflows(store, 'P');
    assert.equal(store.getTask('wf:1').input.nodeId, 'root');
    for (let index = 1; index <= 2; index++) {
      let task = store.getTask(`wf:${index}`);
      for (const stage of task.input.stages) task = store.updateTask(task.id, task.version, workflowChildTransition(task, { outcome: 'PASS' }));
      advanceNodePlanningWorkflows(store, 'P');
    }
    assert.equal(store.getTask('wf:2').taskKind, 'GLOBAL_REVIEW');
    assert.equal(store.getTask('wf').state, 'DONE');
    assert.equal(store.getTask('wf').workflowState.completedNodes.length, 3);
    advanceNodePlanningWorkflows(store, 'P');
    assert.equal(store.listTasks('P').length, 4);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed gate blocks downstream and cannot be mistaken for success', () => {
  const task = { taskKind: 'NODE_PLANNING', stage: 'plan_validator', input: { stages: ['tech_lead', 'plan_validator'] } };
  assert.equal(workflowChildTransition(task, { outcome: 'NOT_PASS' }).state, 'NEEDS_HUMAN');
});
