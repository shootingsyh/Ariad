import test from 'node:test';
import assert from 'node:assert/strict';
import { LegacyRoleResultExecutor } from '../src/v2/legacy-role-result-executor.js';

// Characterization test for the original Scheduler result-advance contract.
// No database migration, new task states, or RoleRegistry API changes.
test('legacy executor preserves RESULT_READY -> READY stage advancement', async () => {
  const task = {
    id: 'T', projectId: 'P', version: 1, scope: 'delivery',
    state: 'RESULT_READY', stage: 'developer', execution: { externalId: 'old' },
    history: [{ type: 'ROLE_RESULT', role: 'developer', outcome: 'PASS' }],
  };
  const updates = [];
  const store = {
    listTasks: () => [task],
    updateTask(id, version, patch) {
      assert.equal(id, 'T');
      assert.equal(version, 1);
      updates.push(patch);
      return { ...task, ...patch, version: 2 };
    },
  };
  const roles = { get: name => {
    assert.ok(['developer', 'reviewer'].includes(name));
    return { transition: () => ({ stage: 'test_engineer', state: 'READY' }) };
  } };
  await new LegacyRoleResultExecutor({ store, roles }).advanceResults('P');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].state, 'READY');
  assert.equal(updates[0].stage, 'test_engineer');
  assert.equal(updates[0].execution, null);
});

test('legacy executor preserves RESULT_READY -> DONE and history behavior', async () => {
  const task = {
    id: 'A', version: 4, scope: 'control', flowId: 'adhoc:P:A',
    taskKind: 'ADHOC_ANALYSIS', stage: 'tech_lead', state: 'RESULT_READY',
    history: [{ type: 'ROLE_RESULT', role: 'tech_lead', outcome: 'PLANNED' }],
  };
  let final;
  const store = {
    listTasks: () => [task],
    updateTask(id, version, patch) {
      assert.equal(version, 4);
      final = { ...task, ...patch, version: 5 };
      return final;
    },
  };
  const roles = { get: () => ({ transition: () => ({ state: 'DONE' }) }) };
  await new LegacyRoleResultExecutor({ store, roles }).advanceResults('P');
  assert.equal(final.state, 'DONE');
});

test('legacy executor preserves adhocOnly and migration filters', async () => {
  const task = { id: 'T', state: 'RESULT_READY', stage: 'developer', scope: 'delivery' };
  const store = { listTasks: () => [task], updateTask: () => { throw Error('must not update'); } };
  const roles = { get: () => { throw Error('must not get role'); } };
  const executor = new LegacyRoleResultExecutor({ store, roles });
  await executor.advanceResults('P', { adhocOnly: true });
  await executor.advanceResults('P', { migrating: true });
});
