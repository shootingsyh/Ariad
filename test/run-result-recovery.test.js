import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeRegistry } from '../src/runtime-registry.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';
import { RuntimeExecutor } from '../src/runtime-executor.js';
import { SQLiteRunStore } from '../src/sqlite-run-store.js';
import { SQLiteWorkflowStateStore } from '../src/sqlite-workflow-state-store.js';
import { TransitionEngine } from '../src/transition-engine.js';
import { WorkflowTransitionService } from '../src/workflow-transition-service.js';
import { recoverCompletedRunResults } from '../src/run-result-recovery.js';

function makeStores() {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-run-result-'));
  const dbFile = join(dir, 'state.db');
  const runs = new SQLiteRunStore(dbFile);
  const workflow = new SQLiteWorkflowStateStore(dbFile);
  const transitions = new WorkflowTransitionService({ store: workflow, engine: new TransitionEngine() });
  return { dir, dbFile, runs, workflow, transitions };
}

function completedRun(runs, { taskId, role, devCycle = 1, strategyEpoch = 1, outcome = 'PASS', result = null }) {
  const run = runs.create({
    taskId,
    role,
    runtimeKey: 'mock',
    runtimeId: 'mock',
    context: { taskId, devCycle, strategyEpoch },
  });
  return runs.update(run.id, {
    state: 'COMPLETED',
    result: { outcome, result },
  });
}

function cleanup({ dir, runs, workflow }) {
  try { runs?.close(); } catch {}
  try { workflow?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

test('completed Run survives crash before workflow transition and is applied exactly once by durable cursor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-run-result-'));
  const dbFile = join(dir, 'state.db');
  let runs;
  let workflow;
  try {
    runs = new SQLiteRunStore(dbFile);
    workflow = new SQLiteWorkflowStateStore(dbFile);
    workflow.create('T1');

    const registry = new RuntimeRegistry();
    registry.register('engineering', createFakeRuntimeAdapter({ script: [{ outcome: 'IMPLEMENTATION_READY', result: { artifact: 'x' } }] }));
    const executor = new RuntimeExecutor({ registry, runStore: runs, roleRuntimeMap: { developer: 'engineering' } });

    const result = await executor.run('developer', { taskId: 'T1', devCycle: 1, strategyEpoch: 1 });
    assert.equal(result.executionStatus, 'COMPLETED');
    assert.equal(workflow.get('T1').stage, 'developer', 'simulate crash before transition is applied');
    assert.equal(runs.list().length, 1);

    runs.close();
    workflow.close();

    runs = new SQLiteRunStore(dbFile);
    workflow = new SQLiteWorkflowStateStore(dbFile);
    const transitions = new WorkflowTransitionService({ store: workflow, engine: new TransitionEngine() });

    const first = await recoverCompletedRunResults({ runStore: runs, stateStore: workflow, transitionService: transitions });
    assert.equal(first.length, 1);
    assert.equal(workflow.get('T1').stage, 'tester');
    assert.equal(workflow.get('T1').devCycle, 1);
    assert.equal(runs.list().length, 1, 'recovery must not create a second Run');

    const versionAfterFirst = workflow.get('T1').version;
    const second = await recoverCompletedRunResults({ runStore: runs, stateStore: workflow, transitionService: transitions });
    assert.equal(second.length, 0, 'durable cursor makes already-applied completed Run stale');
    assert.equal(workflow.get('T1').version, versionAfterFirst);
    assert.equal(runs.list().length, 1);
  } finally {
    try { runs?.close(); } catch {}
    try { workflow?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completed Run from an older business cycle is ignored', async () => {
  const ctx = makeStores();
  try {
    ctx.workflow.create('T-old', { stage: 'developer', devCycle: 2, strategyEpoch: 1 });
    completedRun(ctx.runs, {
      taskId: 'T-old',
      role: 'developer',
      devCycle: 1,
      strategyEpoch: 1,
      outcome: 'IMPLEMENTATION_READY',
    });

    const before = ctx.workflow.get('T-old');
    const recovered = await recoverCompletedRunResults({
      runStore: ctx.runs,
      stateStore: ctx.workflow,
      transitionService: ctx.transitions,
    });

    assert.equal(recovered.length, 0);
    assert.deepEqual(ctx.workflow.get('T-old'), before);
  } finally {
    cleanup(ctx);
  }
});

test('completed Run for a previous stage is ignored after transition already landed', async () => {
  const ctx = makeStores();
  try {
    ctx.workflow.create('T-stage', { stage: 'tester', devCycle: 1, strategyEpoch: 1 });
    completedRun(ctx.runs, {
      taskId: 'T-stage',
      role: 'developer',
      devCycle: 1,
      strategyEpoch: 1,
      outcome: 'IMPLEMENTATION_READY',
    });

    const before = ctx.workflow.get('T-stage');
    const recovered = await recoverCompletedRunResults({
      runStore: ctx.runs,
      stateStore: ctx.workflow,
      transitionService: ctx.transitions,
    });

    assert.equal(recovered.length, 0);
    assert.deepEqual(ctx.workflow.get('T-stage'), before);
  } finally {
    cleanup(ctx);
  }
});

test('completed Run from an older strategy epoch is ignored', async () => {
  const ctx = makeStores();
  try {
    ctx.workflow.create('T-strategy', { stage: 'developer', devCycle: 1, strategyEpoch: 2 });
    completedRun(ctx.runs, {
      taskId: 'T-strategy',
      role: 'developer',
      devCycle: 1,
      strategyEpoch: 1,
      outcome: 'IMPLEMENTATION_READY',
    });

    const before = ctx.workflow.get('T-strategy');
    const recovered = await recoverCompletedRunResults({
      runStore: ctx.runs,
      stateStore: ctx.workflow,
      transitionService: ctx.transitions,
    });

    assert.equal(recovered.length, 0);
    assert.deepEqual(ctx.workflow.get('T-strategy'), before);
  } finally {
    cleanup(ctx);
  }
});
