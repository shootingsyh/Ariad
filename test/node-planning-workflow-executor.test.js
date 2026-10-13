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
      const next = workflowChildTransition(child, { outcome: stage === 'tech_lead' ? 'PLANNED' : stage === 'tech_lead_critic' ? 'CLEAN' : 'PASS' });
      child = store.updateTask(child.id, child.version, next);
    }
    assert.equal(child.state, 'DONE');
    advanceNodePlanningWorkflows(store, 'P');
    assert.equal(store.getTask('wf:1').input.nodeId, 'root');
    for (let index = 1; index <= 2; index++) {
      let task = store.getTask(`wf:${index}`);
      for (const stage of task.input.stages) task = store.updateTask(task.id, task.version, workflowChildTransition(task, { outcome: stage === 'tech_lead' ? 'PLANNED' : stage === 'tech_lead_critic' ? 'CLEAN' : 'PASS' }));
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
  const first = workflowChildTransition(task, { outcome: 'NOT_PASS' });
  assert.equal(first.state, 'READY');
  assert.equal(first.stage, 'tech_lead');
  assert.equal(first.input.workflowRetries, 1);
  const routed = workflowChildTransition({ ...task, input: { ...task.input, workflowRetries: 2 } }, { outcome: 'NOT_PASS' });
  assert.equal(routed.stage, 'project_debugger');
  assert.equal(workflowChildTransition({ ...task, stage: 'project_debugger' }, { outcome: 'UNKNOWN_PROJECT_CAUSE' }).state, 'NEEDS_HUMAN');
  assert.equal(workflowChildTransition({ ...task, taskKind: 'GLOBAL_REVIEW' }, { outcome: 'NOT_PASS' }).stage, 'tech_lead');
});

test('failed child propagates human gate to parent without creating next node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-wf-failure-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P' });
    store.createNodePlanningWorkflow({ id: 'wf', projectId: 'P', phase: 'interface', reason: 'fix', scopeNodeId: 'root', nodes: [{ id: 'root', parentId: null }] });
    advanceNodePlanningWorkflows(store, 'P');
    const child = store.getTask('wf:0');
    store.updateTask(child.id, child.version, { state: 'NEEDS_HUMAN' });
    advanceNodePlanningWorkflows(store, 'P');
    assert.equal(store.getTask('wf').state, 'NEEDS_HUMAN');
    assert.equal(store.getTask('wf').workflowState.blockedChildTaskId, 'wf:0');
    assert.equal(store.listTasks('P').length, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('debugger can grant one bounded guided repair but never auto-approve failed work', () => {
  const task = { taskKind: 'NODE_PLANNING', stage: 'project_debugger', input: { stages: ['tech_lead', 'plan_validator'], workflowRetries: 2, previousGateFailure: { outcome: 'NOT_PASS' } } };
  const repaired = workflowChildTransition(task, { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Repair the missing binding' } });
  assert.equal(repaired.state, 'READY');
  assert.equal(repaired.stage, 'tech_lead');
  assert.equal(repaired.input.debuggerRecoveryCount, 1);
  assert.equal(repaired.input.previousGateFailure.debuggerGuidance, 'Repair the missing binding');
  assert.equal(workflowChildTransition({ ...task, input: repaired.input }, { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'again' } }).state, 'NEEDS_HUMAN');
  assert.equal(workflowChildTransition(task, { outcome: 'RETRY_WITH_GUIDANCE', result: {} }).state, 'NEEDS_HUMAN');
  assert.equal(workflowChildTransition(task, { outcome: 'OVERRIDE_CRITIC' }).state, 'NEEDS_HUMAN');
});

test('global review failure returns to TL with bounded revalidation and debugger escalation', () => {
  const task = { taskKind: 'GLOBAL_REVIEW', stage: 'tech_lead_critic', input: { stages: ['plan_validator', 'tech_lead_critic'] } };
  const retry = workflowChildTransition(task, { outcome: 'ISSUES', result: { issue: 'missing boundary' } });
  assert.equal(retry.stage, 'tech_lead');
  assert.equal(retry.input.workflowRetries, 1);
  assert.equal(workflowChildTransition({ ...task, ...retry }, { outcome: 'PLANNED' }).stage, 'plan_validator');
  assert.equal(workflowChildTransition({ ...task, stage: 'plan_validator', input: retry.input }, { outcome: 'PASS' }).stage, 'tech_lead_critic');
  const exhausted = workflowChildTransition({ ...task, input: { ...retry.input, workflowRetries: 2 } }, { outcome: 'ISSUES' });
  assert.equal(exhausted.stage, 'project_debugger');
  const guided = workflowChildTransition({ ...task, ...exhausted }, { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Repair root boundary' } });
  assert.equal(guided.stage, 'tech_lead');
  assert.equal(guided.input.debuggerRecoveryCount, 1);
  assert.equal(workflowChildTransition({ ...task, ...exhausted, input: { ...exhausted.input, debuggerRecoveryCount: 1 } }, { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'skip' } }).state, 'NEEDS_HUMAN');
});
