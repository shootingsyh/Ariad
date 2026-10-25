import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';

test('workflow child creation and checkpoint advance commit together, rejecting stale replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-workflow-'));
  const db = join(dir, 'state.db');
  let store;
  try {
    store = new SQLiteV2Store(db);
    store.createProject({ id: 'P' });
    const parent = store.createNodePlanningWorkflow({ id: 'wf', projectId: 'P', phase: 'feature', reason: 'update' });
    const child = { id: 'wf:node1', projectId: 'P', scope: 'control', flowId: parent.flowId, parentTaskId: parent.id, taskKind: 'NODE_PLANNING', stage: 'tech_lead' };
    const next = { cursor: 1, activeChildTaskId: child.id, completedNodes: [] };
    const result = store.advanceNodePlanningWorkflow({ parentTaskId: parent.id, expectedVersion: parent.version, childTask: child, workflowState: next });
    assert.equal(result.child.parentTaskId, 'wf');
    assert.equal(result.parent.workflowState.cursor, 1);
    assert.throws(() => store.advanceNodePlanningWorkflow({ parentTaskId: parent.id, expectedVersion: parent.version, childTask: { ...child, id: 'wf:duplicate' }, workflowState: next }), /WORKFLOW_VERSION_CONFLICT/);
    assert.equal(store.getTask('wf:duplicate'), null);
    const invalid = { ...child, id: 'wf:invalid', parentTaskId: 'other' };
    assert.throws(() => store.advanceNodePlanningWorkflow({ parentTaskId: parent.id, expectedVersion: result.parent.version, childTask: invalid, workflowState: next }), /INVALID_WORKFLOW_CHILD/);
    assert.equal(store.getTask('wf:invalid'), null);
    store.close();
    store = new SQLiteV2Store(db);
    assert.equal(store.getTask('wf').workflowState.activeChildTaskId, child.id);
    assert.equal(store.listTasks('P').length, 2);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interface workflow requires explicit node types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-wf-types-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P' });
    assert.throws(() => store.createNodePlanningWorkflow({ id: 'invalid', projectId: 'P', phase: 'interface', reason: 'plan', scopeNodeId: 'root', nodes: [{ id: 'root', parentId: null }] }), /WORKFLOW_NODE_TYPE_REQUIRED/);
    assert.equal(store.getTask('invalid'), null);
    const task = store.createNodePlanningWorkflow({ id: 'valid', projectId: 'P', phase: 'interface', reason: 'plan', scopeNodeId: 'root', nodes: [{ id: 'root', parentId: null, nodeType: 'feature' }] });
    assert.equal(task.input.nodes[0].nodeType, 'feature');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
