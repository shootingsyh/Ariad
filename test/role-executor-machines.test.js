import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutorSignal, validateExecutorOperations } from '../src/v2/executor-dsl.js';
import { milestoneMachine, subPlanMachine, adhocMachine } from '../src/v2/role-executor-machines.js';

test('milestone roles follow the declared four-stage execution path', () => {
  let state = milestoneMachine.initial;
  for (const expected of ['TEST_ENGINEER', 'TEST', 'REVIEW', 'COMPLETE']) {
    state = resolveExecutorSignal(milestoneMachine, state, 'PASS');
    assert.equal(state, expected);
  }
  assert.equal(milestoneMachine.states.COMPLETE.operation, null);
});

test('sub-plan validation and critic failures retry through TL', () => {
  assert.equal(resolveExecutorSignal(subPlanMachine, 'PLAN', 'PASS'), 'VALIDATE');
  assert.equal(resolveExecutorSignal(subPlanMachine, 'VALIDATE', 'RETRY'), 'PLAN');
  assert.equal(resolveExecutorSignal(subPlanMachine, 'CRITIQUE', 'ESCALATE'), 'DEBUG');
  assert.equal(resolveExecutorSignal(subPlanMachine, 'DEBUG', 'NEEDS_HUMAN'), 'FAILED');
});

test('adhoc executor has no delivery stages', () => {
  assert.equal(resolveExecutorSignal(adhocMachine, 'ANALYZE', 'COMPLETE'), 'DONE');
  assert.deepEqual(Object.keys(adhocMachine.states), ['ANALYZE', 'DONE', 'FAILED']);
});

test('all role operations must be registered before execution', () => {
  for (const machine of [milestoneMachine, subPlanMachine, adhocMachine]) {
    const operations = Object.fromEntries(
      Object.values(machine.states).filter(s => s.operation).map(s => [s.operation, () => ({ status: 'PENDING' })]),
    );
    assert.equal(validateExecutorOperations(machine, operations), true);
    assert.throws(() => validateExecutorOperations(machine, {}), /unregistered operation/);
  }
});
