import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQLiteWorkflowStateStore } from '../src/sqlite-workflow-state-store.js';
import { TransitionEngine } from '../src/transition-engine.js';
import { WorkflowTransitionService } from '../src/workflow-transition-service.js';
import { EffectExecutor } from '../src/effect-executor.js';
import { Coordinator } from '../src/coordinator.js';

function stack(dbFile, options = {}) {
  const store = new SQLiteWorkflowStateStore(dbFile);
  const transitions = new WorkflowTransitionService({ store, engine: new TransitionEngine() });
  const effects = new EffectExecutor({ transitionService: transitions, ...options });
  return { store, transitions, effects };
}

test('Tech Lead replan diagnosis is persisted and survives restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-effect-tl-'));
  const dbFile = join(dir, 'state.db');
  try {
    const first = stack(dbFile);
    first.store.create('T1', { stage: 'project_debugger', devCycle: 3 });
    const transition = await first.transitions.apply(
      { taskId: 'T1', role: 'project_debugger' },
      { executionStatus: 'COMPLETED', outcome: 'TASK_TOO_LARGE' },
    );
    await first.effects.execute({ taskId: 'T1', state: transition.state, effect: transition.effect });
    assert.equal(first.store.get('T1').context.diagnosis, 'TASK_TOO_LARGE');
    first.store.close();

    const reopened = new SQLiteWorkflowStateStore(dbFile);
    assert.equal(reopened.get('T1').stage, 'tech_lead');
    assert.equal(reopened.get('T1').context.diagnosis, 'TASK_TOO_LARGE');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strategy guidance is durable across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-effect-guidance-'));
  const dbFile = join(dir, 'state.db');
  try {
    const first = stack(dbFile);
    first.store.create('T2', { stage: 'project_debugger', devCycle: 3 });
    const transition = await first.transitions.apply(
      { taskId: 'T2', role: 'project_debugger' },
      { executionStatus: 'COMPLETED', outcome: 'WRONG_IMPLEMENTATION_APPROACH', guidance: 'Use a queue, not recursion.' },
    );
    await first.effects.execute({ taskId: 'T2', state: transition.state, effect: transition.effect });
    first.store.close();

    const reopened = new SQLiteWorkflowStateStore(dbFile);
    const state = reopened.get('T2');
    assert.equal(state.stage, 'developer');
    assert.equal(state.strategyEpoch, 2);
    assert.equal(state.devCycle, 1);
    assert.equal(state.context.guidance, 'Use a queue, not recursion.');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source control effect finalizes reviewer PASS and only then marks success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-effect-sc-'));
  const dbFile = join(dir, 'state.db');
  const calls = [];
  try {
    const { store, transitions, effects } = stack(dbFile, {
      finalizeSourceControl: async context => { calls.push(context); return { ok: true, commit: 'abc123' }; },
    });
    store.create('T3', { stage: 'reviewer', devCycle: 2, strategyEpoch: 1 });
    const transition = await transitions.apply(
      { taskId: 'T3', role: 'reviewer' },
      { executionStatus: 'COMPLETED', outcome: 'PASS' },
    );
    assert.equal(transition.state.status, 'AWAITING_SOURCE_CONTROL');
    const completed = await effects.execute({ taskId: 'T3', state: transition.state, effect: transition.effect });
    assert.equal(completed.state.status, 'SUCCEEDED');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { taskId: 'T3', strategyEpoch: 1, devCycle: 2 });
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source control failure pauses system rather than becoming reviewer rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-effect-sc-fail-'));
  const dbFile = join(dir, 'state.db');
  try {
    const { store, transitions, effects } = stack(dbFile, {
      finalizeSourceControl: async () => ({ ok: false, failure: 'PUSH_REJECTED' }),
    });
    store.create('T4', { stage: 'reviewer' });
    const transition = await transitions.apply(
      { taskId: 'T4', role: 'reviewer' },
      { executionStatus: 'COMPLETED', outcome: 'PASS' },
    );
    const completed = await effects.execute({ taskId: 'T4', state: transition.state, effect: transition.effect });
    assert.equal(completed.state.status, 'PAUSED_SYSTEM');
    assert.equal(completed.state.devCycle, 1);
    assert.equal(completed.effect.type, 'RELIABILITY_REQUIRED');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Coordinator executes returned workflow effects after semantic transition', async () => {
  const seen = [];
  const coordinator = new Coordinator({
    scheduler: { async tryDispatch() { return { status: 'DISPATCHED', result: { executionStatus: 'COMPLETED', outcome: 'PASS' } }; } },
    applyExecutionResult: async () => ({ state: { taskId: 'T5', stage: 'reviewer', devCycle: 1, strategyEpoch: 1, status: 'AWAITING_SOURCE_CONTROL' }, effect: { type: 'FINALIZE_SOURCE_CONTROL' } }),
    effectExecutor: { async execute(input) { seen.push(input); return { state: { ...input.state, status: 'SUCCEEDED' }, effect: null }; } },
  });
  const [result] = await coordinator.tick([{ taskId: 'T5', role: 'reviewer', runtimeKey: 'fake', resources: [] }]);
  assert.equal(result.status, 'APPLIED');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].effect.type, 'FINALIZE_SOURCE_CONTROL');
  assert.equal(result.effectResult.state.status, 'SUCCEEDED');
});
