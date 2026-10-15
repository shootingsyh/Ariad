import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { milestoneResultTransition } from '../src/v2/milestone-result-executor.js';
import { persistRoleExecutorTransition } from '../src/v2/role-executor-persistence.js';

function fixture() {
  const store = new SQLiteV2Store(':memory:');
  store.createProject({ id: 'P' });
  store.createTask({
    id: 'blocked', projectId: 'P', scope: 'delivery', stage: 'project_debugger',
    state: 'SYSTEM_BLOCKED', history: [],
  });
  store.createTask({
    id: 'debug', projectId: 'P', scope: 'delivery', stage: 'project_debugger',
    state: 'RESULT_READY', input: { blockedTaskId: 'blocked' },
    history: [{ type: 'ROLE_RESULT', role: 'project_debugger', outcome: 'WRONG_IMPLEMENTATION_APPROACH' }],
  });
  return store;
}

test('debugger recovery updates both tasks atomically', async () => {
  const store = fixture();
  const task = store.getTask('debug');
  const result = task.history.at(-1);
  const next = milestoneResultTransition(task, result);
  await persistRoleExecutorTransition({ store, roles: { get: () => ({}) }, task, result, next });
  assert.equal(store.getTask('debug').state, 'DONE');
  assert.equal(store.getTask('blocked').state, 'READY');
  assert.equal(store.getTask('blocked').stage, 'developer');
  assert.equal(store.getTask('blocked').history.at(-1).type, 'DEBUGGER_ROUTE');
});

test('stale debugger version rolls back blocked-task update', () => {
  const store = fixture();
  const task = store.getTask('debug');
  store.updateTask('debug', task.version, { summary: 'newer update' });
  assert.throws(() => store.applyExecutorBlockedRoute({
    taskId: 'debug', expectedVersion: task.version,
    patch: { state: 'DONE' },
    blockedRoute: { taskId: 'blocked', patch: { stage: 'developer', state: 'READY' }, history: { type: 'DEBUGGER_ROUTE' } },
  }), /version conflict/);
  assert.equal(store.getTask('blocked').state, 'SYSTEM_BLOCKED');
  assert.equal(store.getTask('debug').state, 'RESULT_READY');
});

test('debugger cannot update another project through blocked route', () => {
  const store = fixture();
  store.createProject({ id: 'Q' });
  store.createTask({ id: 'foreign', projectId: 'Q', scope: 'delivery', stage: 'developer', state: 'SYSTEM_BLOCKED' });
  const task = store.getTask('debug');
  assert.throws(() => store.applyExecutorBlockedRoute({
    taskId: task.id, expectedVersion: task.version, patch: { state: 'DONE' },
    blockedRoute: { taskId: 'foreign', patch: { state: 'READY' }, history: { type: 'DEBUGGER_ROUTE' } },
  }), /cross-project/);
  assert.equal(store.getTask('foreign').state, 'SYSTEM_BLOCKED');
});

test('debugger replan enqueues request and changes blocked task in one transaction', async () => {
  const store = fixture();
  const task = store.getTask('debug');
  const result = { outcome: 'TASK_TOO_LARGE', result: { reason: 'oversized' } };
  const next = milestoneResultTransition(task, result);
  await persistRoleExecutorTransition({ store, roles: { get: () => ({}) }, task, result, next });
  assert.equal(store.getTask('debug').state, 'DONE');
  assert.equal(store.getTask('blocked').state, 'WAITING_REPLAN');
  assert.equal(store.getTask('blocked').stage, 'developer');
  const requests = store.listPlanningRequests('P', { state: 'PENDING' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.purpose, 'REPLAN_TASK');
  assert.equal(requests[0].request.taskId, 'blocked');
});

test('duplicate replan request rolls back debugger and blocked task', async () => {
  const store = fixture();
  const task = store.getTask('debug');
  const result = { outcome: 'TASK_TOO_LARGE' };
  const next = milestoneResultTransition(task, result);
  store.enqueuePlanningRequest({ ...next.planningRequest, projectId: 'P' });
  await assert.rejects(
    persistRoleExecutorTransition({ store, roles: { get: () => ({}) }, task, result, next }),
  );
  assert.equal(store.getTask('debug').state, 'RESULT_READY');
  assert.equal(store.getTask('blocked').state, 'SYSTEM_BLOCKED');
});
