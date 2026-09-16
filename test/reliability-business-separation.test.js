import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReliabilityService } from '../src/reliability.js';
import { SQLiteIncidentStore } from '../src/sqlite-incident-store.js';
import { SQLiteWorkflowStateStore } from '../src/sqlite-workflow-state-store.js';
import { ExecutionReliabilityBridge } from '../src/execution-reliability-bridge.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-reliability-system-'));
  return { dir, file: path.join(dir, 'state.db') };
}

test('execution failure and interrupted recovery do not advance business dev cycle across restart', async () => {
  const { dir, file } = tempDb();

  let workflowStore = new SQLiteWorkflowStateStore(file);
  let incidentStore = new SQLiteIncidentStore(file);
  workflowStore.create('TASK-1', { stage: 'tester', devCycle: 1, strategyEpoch: 1, status: 'RUNNING' });

  const reliabilityBeforeCrash = new ReliabilityService({
    incidentStore,
    policies: { EXECUTION_FAILURE: ['restart_runtime'] },
    execute: async () => { throw new Error('synthetic Ariad crash during recovery'); },
  });
  const bridge = new ExecutionReliabilityBridge({ reliability: reliabilityBeforeCrash });

  const incident = bridge.observe({
    taskId: 'TASK-1',
    runId: 'RUN-7',
    runtimeKey: 'engineering',
    execution: { executionStatus: 'FAILED', failure: 'MODEL_DOWN', runState: 'FAILED' },
  });

  assert.equal(incident.type, 'EXECUTION_FAILURE');
  assert.equal(incident.target, 'RUN-7');
  assert.deepEqual(
    { stage: workflowStore.get('TASK-1').stage, devCycle: workflowStore.get('TASK-1').devCycle },
    { stage: 'tester', devCycle: 1 },
  );

  await assert.rejects(() => reliabilityBeforeCrash.recover(incident.id), /synthetic Ariad crash/);
  const interrupted = incidentStore.get(incident.id);
  assert.equal(interrupted.state, 'RECOVERING');
  assert.equal(interrupted.recoveryStep, 0);
  assert.equal(interrupted.activeAction, 'restart_runtime');

  workflowStore.close();
  incidentStore.close();

  // Simulate a brand-new Ariad process opening the same durable truth.
  workflowStore = new SQLiteWorkflowStateStore(file);
  incidentStore = new SQLiteIncidentStore(file);
  const executed = [];
  const reliabilityAfterRestart = new ReliabilityService({
    incidentStore,
    policies: { EXECUTION_FAILURE: ['restart_runtime'] },
    execute: async action => { executed.push(action); return true; },
  });

  const recovered = await reliabilityAfterRestart.recover(incident.id);
  assert.equal(recovered.state, 'RECOVERED');
  assert.deepEqual(executed, ['restart_runtime']);

  const businessAfterRecovery = workflowStore.get('TASK-1');
  assert.equal(businessAfterRecovery.stage, 'tester');
  assert.equal(businessAfterRecovery.devCycle, 1);
  assert.equal(businessAfterRecovery.strategyEpoch, 1);

  // A successful retry may advance the stage, but still in the same semantic dev cycle.
  const continued = workflowStore.update('TASK-1', businessAfterRecovery.version, { stage: 'reviewer' });
  assert.equal(continued.stage, 'reviewer');
  assert.equal(continued.devCycle, 1);

  workflowStore.close();
  incidentStore.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('business rejection is not converted into a reliability incident', () => {
  const reliability = new ReliabilityService();
  const bridge = new ExecutionReliabilityBridge({ reliability });
  const observed = bridge.observe({
    taskId: 'TASK-2',
    runId: 'RUN-8',
    execution: { executionStatus: 'COMPLETED', outcome: 'NOT_PASS' },
  });
  assert.equal(observed, null);
  assert.equal(reliability.list().length, 0);
});
