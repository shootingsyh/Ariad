import test from 'node:test';
import assert from 'node:assert/strict';
import { roleExecutorBinding } from '../src/v2/role-executor-binding.js';

test('delivery stages belong to milestone executor', () => {
  for (const [stage, state] of Object.entries({
    developer: 'DEVELOP', test_engineer: 'TEST_ENGINEER', tester: 'TEST',
    reviewer: 'REVIEW', project_debugger: 'DEBUG',
  })) {
    const binding = roleExecutorBinding({ scope: 'delivery', stage });
    assert.equal(binding.machine.id, 'milestone-executor');
    assert.equal(binding.state, state);
  }
});

test('workflow child stages belong to sub-plan executor', () => {
  const binding = roleExecutorBinding({ scope: 'control', taskKind: 'NODE_PLANNING', stage: 'plan_validator' });
  assert.equal(binding.machine.id, 'sub-plan-executor');
  assert.equal(binding.state, 'VALIDATE');
});

test('adhoc analysis has one role, not a delivery workflow', () => {
  const binding = roleExecutorBinding({ scope: 'control', taskKind: 'ADHOC_ANALYSIS', stage: 'tech_lead' });
  assert.equal(binding.machine.id, 'adhoc-executor');
  assert.equal(binding.state, 'ANALYZE');
  assert.throws(() => roleExecutorBinding({ scope: 'control', taskKind: 'ADHOC_ANALYSIS', stage: 'reviewer' }), /UNSUPPORTED_EXECUTOR_ROLE/);
});

test('PM and diagnostics require explicit executors, not guessed role transitions', () => {
  assert.equal(roleExecutorBinding({ scope: 'control', taskKind: 'REVIEW_GATE', stage: 'pm' }), null);
  assert.equal(roleExecutorBinding({ scope: 'control', taskKind: 'DIAGNOSTIC', stage: 'project_debugger' }), null);
});
