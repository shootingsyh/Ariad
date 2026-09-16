import test from 'node:test';
import assert from 'node:assert/strict';

import { ReliabilityExecutionExecutor } from '../src/reliability-execution-executor.js';
import { ReliabilityService } from '../src/reliability.js';

function scriptedExecutor(results) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async run(role, context) {
      calls.push({ role, context: structuredClone(context) });
      if (index >= results.length) throw new Error('script exhausted');
      return structuredClone(results[index++]);
    },
  };
}

test('execution failure is recovered and retried outside workflow business logic', async () => {
  const base = scriptedExecutor([
    { executionStatus: 'FAILED', failure: 'MODEL_DOWN', runId: 'RUN-1' },
    { executionStatus: 'COMPLETED', outcome: 'PASS', runId: 'RUN-2' },
  ]);
  const actions = [];
  const reliability = new ReliabilityService({
    policies: { EXECUTION_FAILURE: ['RESTART_MODEL'] },
    execute: async action => { actions.push(action); return true; },
  });
  const attempts = [];
  const executor = new ReliabilityExecutionExecutor({ executor: base, reliability, maxRecoveries: 2 });

  const result = await executor.run('tester', { taskId: 'F1', devCycle: 1 }, {
    onAttempt: x => attempts.push(x.executionStatus),
  });

  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.outcome, 'PASS');
  assert.deepEqual(actions, ['RESTART_MODEL']);
  assert.deepEqual(attempts, ['FAILED', 'COMPLETED']);
  assert.equal(base.calls.length, 2);
  assert.equal(reliability.list().length, 1);
  assert.equal(reliability.list()[0].state, 'RECOVERED');
});

test('failed recovery does not retry execution and returns recovery exhaustion', async () => {
  const base = scriptedExecutor([
    { executionStatus: 'FAILED', failure: 'MODEL_DOWN', runId: 'RUN-1' },
  ]);
  const reliability = new ReliabilityService({
    policies: { EXECUTION_FAILURE: ['RESTART_MODEL'] },
    execute: async () => false,
  });
  const executor = new ReliabilityExecutionExecutor({ executor: base, reliability, maxRecoveries: 2 });

  const result = await executor.run('developer', { taskId: 'F2', devCycle: 1 });

  assert.equal(result.executionStatus, 'FAILED');
  assert.equal(result.recoveryExhausted, true);
  assert.equal(base.calls.length, 1);
  assert.equal(reliability.list()[0].state, 'ESCALATED');
});

test('max recovery count bounds repeated execution failures', async () => {
  const base = scriptedExecutor([
    { executionStatus: 'FAILED', failure: 'A', runId: 'RUN-1' },
    { executionStatus: 'FAILED', failure: 'B', runId: 'RUN-2' },
    { executionStatus: 'FAILED', failure: 'C', runId: 'RUN-3' },
  ]);
  const reliability = new ReliabilityService({
    policies: { EXECUTION_FAILURE: ['RETRY_EXECUTION'] },
    execute: async () => true,
  });
  const executor = new ReliabilityExecutionExecutor({ executor: base, reliability, maxRecoveries: 2 });

  const result = await executor.run('developer', { taskId: 'F3', devCycle: 1 });

  assert.equal(result.executionStatus, 'FAILED');
  assert.equal(result.recoveryExhausted, true);
  assert.equal(base.calls.length, 3);
  assert.equal(reliability.list().length, 2);
});

test('business NOT_PASS never creates a reliability incident', async () => {
  const base = scriptedExecutor([
    { executionStatus: 'COMPLETED', outcome: 'NOT_PASS' },
  ]);
  const reliability = new ReliabilityService({
    policies: { EXECUTION_FAILURE: ['RETRY_EXECUTION'] },
    execute: async () => true,
  });
  const executor = new ReliabilityExecutionExecutor({ executor: base, reliability, maxRecoveries: 2 });

  const result = await executor.run('reviewer', { taskId: 'F4', devCycle: 1 });

  assert.equal(result.outcome, 'NOT_PASS');
  assert.equal(reliability.list().length, 0);
});
