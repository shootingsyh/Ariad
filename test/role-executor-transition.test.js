import test from 'node:test';
import assert from 'node:assert/strict';
import { executorTransitionFromResult } from '../src/v2/role-executor-transition.js';

test('milestone signal advances developer to test engineer', () => {
  const t = executorTransitionFromResult({ taskKind: 'MILESTONE_TASK', stage: 'developer' }, 'PASS');
  assert.equal(t.to, 'TEST_ENGINEER');
  assert.deepEqual(t.patch, { state: 'READY', stage: 'test_engineer' });
});

test('milestone reviewer completion becomes DONE', () => {
  assert.deepEqual(executorTransitionFromResult({ taskKind: 'MILESTONE_TASK', stage: 'reviewer' }, 'PASS').patch, { state: 'DONE' });
});

test('sub-plan validation retry returns to tech lead', () => {
  const t = executorTransitionFromResult({ scope: 'control', taskKind: 'NODE_PLANNING', stage: 'plan_validator' }, 'RETRY');
  assert.deepEqual(t.patch, { state: 'READY', stage: 'tech_lead' });
});

test('debugger failure becomes human intervention, not success', () => {
  const t = executorTransitionFromResult({ taskKind: 'MILESTONE_TASK', stage: 'project_debugger' }, 'NEEDS_HUMAN');
  assert.deepEqual(t.patch, { state: 'NEEDS_HUMAN' });
});

test('unsupported signals fail closed and PM tasks remain separate', () => {
  assert.throws(() => executorTransitionFromResult({ taskKind: 'MILESTONE_TASK', stage: 'reviewer' }, 'OVERRIDE'), /unexpected signal/);
  assert.equal(executorTransitionFromResult({ scope: 'control', taskKind: 'REVIEW_GATE', stage: 'pm' }, 'PASS'), null);
});
