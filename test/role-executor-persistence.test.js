import test from 'node:test';
import assert from 'node:assert/strict';
import { persistRoleExecutorTransition } from '../src/v2/role-executor-persistence.js';
import { subPlanResultTransition } from '../src/v2/sub-plan-result-executor.js';

function fixture() {
  let task = {
    id: 'child', version: 1, state: 'RESULT_READY', stage: 'plan_validator',
    taskKind: 'NODE_PLANNING', scope: 'control',
    input: { stages: ['tech_lead', 'plan_validator'] },
    execution: { externalId: 'session' },
  };
  const store = {
    getTask: id => id === 'child' ? task : null,
    updateTask(id, version, patch) {
      assert.equal(id, task.id);
      if (version !== task.version) throw new Error('version conflict');
      task = { ...task, ...patch, version: version + 1 };
      return task;
    },
    appendTaskHistory(id, version, entry) {
      assert.equal(version, task.version);
      task = { ...task, history: [...(task.history ?? []), entry], version: version + 1 };
      return task;
    },
  };
  const roles = { get: () => ({}) };
  return { store, roles, getTask: () => task };
}

test('sub-plan signal is persisted through RESULT_READY lifecycle', async () => {
  const f = fixture();
  const task = f.getTask();
  const result = { outcome: 'PASS' };
  const next = subPlanResultTransition(task, result);
  await persistRoleExecutorTransition({ store: f.store, roles: f.roles, task, result, next });
  assert.equal(f.getTask().state, 'DONE');
  assert.equal(f.getTask().execution, null);
});

test('sub-plan retry writes failure evidence and returns to TL', async () => {
  const f = fixture();
  const task = f.getTask();
  const result = { outcome: 'NOT_PASS', result: { issue: 'invalid plan' } };
  const next = subPlanResultTransition(task, result);
  await persistRoleExecutorTransition({ store: f.store, roles: f.roles, task, result, next });
  assert.equal(f.getTask().state, 'READY');
  assert.equal(f.getTask().stage, 'tech_lead');
  assert.equal(f.getTask().input.workflowRetries, 1);
  assert.deepEqual(f.getTask().input.previousGateFailure.details, { issue: 'invalid plan' });
});

test('stale task version cannot commit a second transition', async () => {
  const f = fixture();
  const task = f.getTask();
  const result = { outcome: 'PASS' };
  const next = subPlanResultTransition(task, result);
  await persistRoleExecutorTransition({ store: f.store, roles: f.roles, task, result, next });
  await assert.rejects(
    persistRoleExecutorTransition({ store: f.store, roles: f.roles, task, result, next }),
    /version/,
  );
});
