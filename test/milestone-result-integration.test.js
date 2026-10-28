import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleResultDispatcher } from '../src/v2/role-result-dispatcher.js';

function run(stage, outcome, extra = {}) {
  let task = {
    id: 'M', projectId: 'P', version: 1, state: 'RESULT_READY',
    scope: 'delivery', taskKind: 'MILESTONE_TASK', stage,
    history: [{ type: 'ROLE_RESULT', role: stage, outcome, ...extra }],
  };
  const store = {
    listTasks: () => [task],
    updateTask(id, version, patch) {
      assert.equal(id, task.id);
      assert.equal(version, task.version);
      task = { ...task, ...patch, version: version + 1 };
      return task;
    },
  };
  const roles = { get: () => ({
    transition: () => { throw new Error('legacy transition called'); },
  }) };
  return new RoleResultDispatcher({ store, roles }).advanceResults('P')
    .then(() => task);
}
test('milestone developer result uses DSL in scheduler adapter', async () => {
  const task = await run('developer', 'PASS');
  assert.equal(task.state, 'READY');
  assert.equal(task.stage, 'test_engineer');
});
test('milestone tester plan invalidation returns to test engineer', async () => {
  const task = await run('tester', 'NOT_PASS', { result: { testPlanInvalid: true } });
  assert.equal(task.state, 'READY');
  assert.equal(task.stage, 'test_engineer');
});
test('milestone developer failed attempt cannot silently advance', async () => {
  const task = await run('developer', 'NOT_PASS');
  assert.equal(task.state, 'READY');
  assert.equal(task.stage, 'developer');
});
