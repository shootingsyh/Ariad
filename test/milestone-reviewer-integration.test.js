import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleResultDispatcher } from '../src/v2/role-result-dispatcher.js';

async function advance({ outcome = 'PASS', ux = false, configuredUx = false, role = 'reviewer', afterPersist } = {}) {
  let task = {
    id: 'M', projectId: 'P', version: 1, scope: 'delivery',
    taskKind: 'MILESTONE_TASK', stage: role, state: 'RESULT_READY',
    ux: { required: true },
    history: [{ type: 'ROLE_RESULT', role, outcome }],
  };
  const store = {
    listTasks: () => [task],
    updateTask(id, version, patch) {
      assert.equal(version, task.version);
      task = { ...task, ...patch, version: version + 1 };
      return task;
    },
    appendTaskHistory(id, version, entry) {
      assert.equal(version, task.version);
      task = { ...task, history: [...task.history, entry], version: version + 1 };
      return task;
    },
  };
  const roles = { get: () => ({
    uxReviewEnabled: configuredUx,
    transition: () => { throw new Error('legacy transition must not run'); },
    ...(afterPersist ? { afterPersist } : {}),
  }) };
  await new RoleResultDispatcher({ store, roles, uxReviewEnabled: ux }).advanceResults('P');
  return task;
}

test('reviewer PASS completes milestone via DSL and still executes afterPersist', async () => {
  let observed = false;
  const task = await advance({ afterPersist: ({ task }) => {
    assert.equal(task.state, 'DONE');
    observed = true;
    return null;
  } });
  assert.equal(task.state, 'DONE');
  assert.equal(observed, true);
});

test('reviewer PASS routes to UX review when enabled and required', async () => {
  const task = await advance({ ux: true });
  assert.equal(task.state, 'READY');
  assert.equal(task.stage, 'ux_reviewer');
});

test('UX reviewer PASS completes milestone through DSL', async () => {
  const task = await advance({ ux: true, role: 'ux_reviewer' });
  assert.equal(task.state, 'DONE');
});

test('reviewer NOT_PASS returns to developer', async () => {
  const task = await advance({ outcome: 'NOT_PASS' });
  assert.equal(task.state, 'READY');
  assert.equal(task.stage, 'developer');
});

test('reviewer honors UX policy from role factory without scheduler override', async () => {
  const task = await advance({ configuredUx: true });
  assert.equal(task.stage, 'ux_reviewer');
  assert.equal(task.state, 'READY');
});
