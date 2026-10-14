import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceExecutor } from '../src/v2/executor-driver.js';
import { planningTraversalMachine } from '../src/v2/planning-traversal-machine.js';

test('planning executor yields while child runs and resumes from checkpoint', async () => {
  let childDone = false;
  const operations = {
    selectNextNode: () => ({ status: 'SIGNAL', signal: 'NODE_FOUND' }),
    createChild: () => ({ status: 'SIGNAL', signal: 'CREATED' }),
    observeChild: () => childDone
      ? ({ status: 'SIGNAL', signal: 'CHILD_COMPLETE' })
      : ({ status: 'PENDING' }),
  };
  const waiting = await advanceExecutor({ machine: planningTraversalMachine, operations });
  assert.equal(waiting.status, 'PENDING');
  assert.equal(waiting.state, 'WAIT_CHILD');
  childDone = true;
  const resumed = await advanceExecutor({ machine: planningTraversalMachine, operations, checkpoint: { state: waiting.state }, maxSteps: 1 });
  assert.equal(resumed.status, 'YIELDED');
  assert.equal(resumed.state, 'TRAVERSE');
});

test('planning traversal completes without invoking a model', async () => {
  const result = await advanceExecutor({
    machine: planningTraversalMachine,
    operations: {
      selectNextNode: () => ({ status: 'SIGNAL', signal: 'EXHAUSTED' }),
      createChild: () => { throw new Error('should not spawn'); },
      observeChild: () => { throw new Error('should not wait'); },
    },
  });
  assert.equal(result.status, 'TERMINAL');
  assert.equal(result.state, 'COMPLETE');
});

test('child failure maps to terminal failed state', async () => {
  const result = await advanceExecutor({
    machine: planningTraversalMachine,
    checkpoint: { state: 'WAIT_CHILD' },
    operations: {
      selectNextNode() {},
      createChild() {},
      observeChild: () => ({ status: 'SIGNAL', signal: 'CHILD_FAILED' }),
    },
  });
  assert.equal(result.status, 'TERMINAL');
  assert.equal(result.state, 'FAILED');
});

test('bounded automatic transitions yield without an infinite loop', async () => {
  const result = await advanceExecutor({
    machine: planningTraversalMachine,
    operations: {
      selectNextNode: () => ({ status: 'SIGNAL', signal: 'NODE_FOUND' }),
      createChild: () => ({ status: 'SIGNAL', signal: 'CREATED' }),
      observeChild: () => ({ status: 'SIGNAL', signal: 'CHILD_COMPLETE' }),
    },
    maxSteps: 6,
  });
  assert.equal(result.status, 'YIELDED');
  assert.equal(result.transitions.length, 6);
});
