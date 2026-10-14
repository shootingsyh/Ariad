import test from 'node:test';
import assert from 'node:assert/strict';
import { defineExecutorMachine, resolveExecutorSignal, executorStep, validateExecutorOperations } from '../src/v2/executor-dsl.js';

const planning = defineExecutorMachine({
  id: 'planning', initial: 'TRAVERSE',
  states: {
    TRAVERSE: { operation: 'traverse', transitions: { NEXT: 'WAIT', DONE: 'COMPLETE' } },
    WAIT: { operation: 'awaitChild', transitions: { CHILD_COMPLETE: 'TRAVERSE', CHILD_FAILED: 'FAILED' } },
    COMPLETE: {}, FAILED: {},
  },
});

test('planning waits without advancing or allocating resources', () => {
  assert.deepEqual(executorStep(planning, 'WAIT', { status: 'PENDING' }), { state: 'WAIT', pending: true });
  assert.deepEqual(executorStep(planning, 'WAIT', { status: 'SIGNAL', signal: 'CHILD_COMPLETE' }), { state: 'TRAVERSE', pending: false });
  assert.equal(resolveExecutorSignal(planning, 'TRAVERSE', 'DONE'), 'COMPLETE');
});

test('rejects undeclared transitions and terminal signals', () => {
  assert.throws(() => resolveExecutorSignal(planning, 'WAIT', 'RETRY'), /unexpected signal/);
  assert.throws(() => resolveExecutorSignal(planning, 'COMPLETE', 'ANY'), /terminal/);
});

test('rejects invalid or imperative DSL definitions', () => {
  assert.throws(() => defineExecutorMachine({ id: 'x', initial: 'A', states: { A: { action: () => {} } } }), /unsupported DSL field/);
  assert.throws(() => defineExecutorMachine({ id: 'x', initial: 'A', states: { A: { operation: 'work', transitions: { OK: 'MISSING' } } } }), /invalid transition/);
  assert.throws(() => defineExecutorMachine({ id: 'x', initial: 'A', states: { A: { transitions: { OK: 'A' } } } }), /terminal state/);
});

test('validates operation registry separately from DSL', () => {
  assert.equal(validateExecutorOperations(planning, { traverse() {}, awaitChild() {} }), true);
  assert.throws(() => validateExecutorOperations(planning, { traverse() {} }), /unregistered operation/);
});
