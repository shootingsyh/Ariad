import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Coordinator } from '../src/coordinator.js';
import { Scheduler } from '../src/scheduler.js';
import { RuntimeRegistry } from '../src/runtime-registry.js';
import { RuntimeExecutor } from '../src/runtime-executor.js';
import { SQLiteRunStore } from '../src/sqlite-run-store.js';
import { SQLiteWorkflowStateStore } from '../src/sqlite-workflow-state-store.js';
import { TransitionEngine } from '../src/transition-engine.js';
import { WorkflowTransitionService } from '../src/workflow-transition-service.js';
import { ScriptedLLM } from '../src/llm/scripted.js';
import { LLMWorkflowRoleExecutor } from '../src/llm/workflow-role-executor.js';
import { PromptRenderer } from '../src/llm/prompt-renderer.js';
import { LLMRuntimeAdapter } from '../src/adapters/llm-runtime.js';

const promptRenderer = new PromptRenderer();

function requestFor(role, context) {
  return promptRenderer.render(role, context);
}

function makeStack({ dbFile, llm, taskId }) {
  const runStore = new SQLiteRunStore(dbFile);
  const workflowStore = new SQLiteWorkflowStateStore(dbFile);
  const transitionEngine = new TransitionEngine();
  const transitions = new WorkflowTransitionService({ store: workflowStore, engine: transitionEngine });
  const roleExecutor = new LLMWorkflowRoleExecutor(llm);
  const runtime = new LLMRuntimeAdapter({ roleExecutor });
  const registry = new RuntimeRegistry();
  registry.register('scripted_llm', runtime);
  const runtimeExecutor = new RuntimeExecutor({
    registry,
    runStore,
    roleRuntimeMap: {
      developer: 'scripted_llm',
      tester: 'scripted_llm',
      reviewer: 'scripted_llm',
    },
  });
  const scheduler = new Scheduler({
    resourceManager: { tryAcquire() { throw new Error('no resources expected'); } },
    isRuntimeHealthy: () => true,
    dispatch: (work) => runtimeExecutor.run(work.role, work.context),
  });
  const coordinator = new Coordinator({
    scheduler,
    applyExecutionResult: (work, result) => transitions.apply(work, result),
  });
  return { runStore, workflowStore, transitions, coordinator };
}

function workFromState(taskId, state) {
  return {
    taskId,
    role: state.stage,
    runtimeKey: 'scripted_llm',
    resources: [],
    context: {
      taskId,
      strategyEpoch: state.strategyEpoch,
      devCycle: state.devCycle,
    },
  };
}

function finalizeIfRequested(stack, taskId, outcome) {
  if (outcome.transition?.effect?.type !== 'FINALIZE_SOURCE_CONTROL') return null;
  return stack.transitions.completeSourceControl(taskId, { ok: true });
}

test('full Ariad execution survives restart between LLM roles using SQLite durable truth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-system-transcript-'));
  const dbFile = join(dir, 'state.db');
  const taskId = 'FEATURE-RESTART-1';

  try {
    const phase1Context = { taskId, strategyEpoch: 1, devCycle: 1 };
    const phase1LLM = new ScriptedLLM([
      {
        request: requestFor('developer', phase1Context),
        output: { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTED', summary: 'patch ready' },
      },
    ]);
    const phase1 = makeStack({ dbFile, llm: phase1LLM, taskId });
    phase1.workflowStore.create(taskId);

    const firstState = phase1.workflowStore.get(taskId);
    const [developerOutcome] = await phase1.coordinator.tick([workFromState(taskId, firstState)]);
    assert.equal(developerOutcome.status, 'APPLIED');
    assert.equal(phase1.workflowStore.get(taskId).stage, 'tester');
    assert.equal(phase1.runStore.list().length, 1);
    assert.equal(phase1.runStore.list()[0].role, 'developer');
    assert.equal(phase1.runStore.list()[0].state, 'COMPLETED');
    phase1LLM.assertExhausted();

    phase1.workflowStore.close();
    phase1.runStore.close();

    const testerContext = { taskId, strategyEpoch: 1, devCycle: 1 };
    const reviewerContext = { taskId, strategyEpoch: 1, devCycle: 1 };
    const phase2LLM = new ScriptedLLM([
      {
        request: requestFor('tester', testerContext),
        output: { executionStatus: 'COMPLETED', outcome: 'PASS' },
      },
      {
        request: requestFor('reviewer', reviewerContext),
        output: { executionStatus: 'COMPLETED', outcome: 'PASS' },
      },
    ]);
    const phase2 = makeStack({ dbFile, llm: phase2LLM, taskId });

    const recovered = phase2.workflowStore.get(taskId);
    assert.deepEqual(
      { stage: recovered.stage, devCycle: recovered.devCycle, strategyEpoch: recovered.strategyEpoch, status: recovered.status },
      { stage: 'tester', devCycle: 1, strategyEpoch: 1, status: 'RUNNING' },
    );
    assert.equal(phase2.runStore.list().length, 1);

    const [testerOutcome] = await phase2.coordinator.tick([workFromState(taskId, recovered)]);
    assert.equal(testerOutcome.status, 'APPLIED');
    assert.equal(phase2.workflowStore.get(taskId).stage, 'reviewer');

    const reviewerState = phase2.workflowStore.get(taskId);
    const [reviewerOutcome] = await phase2.coordinator.tick([workFromState(taskId, reviewerState)]);
    assert.equal(reviewerOutcome.status, 'APPLIED');
    assert.equal(phase2.workflowStore.get(taskId).status, 'AWAITING_SOURCE_CONTROL');
    finalizeIfRequested(phase2, taskId, reviewerOutcome);
    assert.equal(phase2.workflowStore.get(taskId).status, 'SUCCEEDED');

    const runs = phase2.runStore.list();
    assert.deepEqual(runs.map((run) => run.role), ['developer', 'tester', 'reviewer']);
    assert.ok(runs.every((run) => run.state === 'COMPLETED'));
    assert.deepEqual(runs.map((run) => run.result?.outcome), ['IMPLEMENTED', 'PASS', 'PASS']);
    phase2LLM.assertExhausted();

    phase2.workflowStore.close();
    phase2.runStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewer rejection advances dev cycle durably and restart resumes developer cycle 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-review-restart-'));
  const dbFile = join(dir, 'state.db');
  const taskId = 'FEATURE-REVIEW-RESTART';

  try {
    const cycle1 = { taskId, strategyEpoch: 1, devCycle: 1 };
    const phase1LLM = new ScriptedLLM([
      { request: requestFor('developer', cycle1), output: { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTED' } },
      { request: requestFor('tester', cycle1), output: { executionStatus: 'COMPLETED', outcome: 'PASS' } },
      { request: requestFor('reviewer', cycle1), output: { executionStatus: 'COMPLETED', outcome: 'NOT_PASS' } },
    ]);
    const phase1 = makeStack({ dbFile, llm: phase1LLM, taskId });
    phase1.workflowStore.create(taskId);

    for (const expectedRole of ['developer', 'tester', 'reviewer']) {
      const current = phase1.workflowStore.get(taskId);
      assert.equal(current.stage, expectedRole);
      const [outcome] = await phase1.coordinator.tick([workFromState(taskId, current)]);
      assert.equal(outcome.status, 'APPLIED');
    }

    const rejected = phase1.workflowStore.get(taskId);
    assert.deepEqual(
      { stage: rejected.stage, devCycle: rejected.devCycle, strategyEpoch: rejected.strategyEpoch, status: rejected.status },
      { stage: 'developer', devCycle: 2, strategyEpoch: 1, status: 'RUNNING' },
    );
    phase1LLM.assertExhausted();
    phase1.workflowStore.close();
    phase1.runStore.close();

    const cycle2 = { taskId, strategyEpoch: 1, devCycle: 2 };
    const phase2LLM = new ScriptedLLM([
      { request: requestFor('developer', cycle2), output: { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTED' } },
      { request: requestFor('tester', cycle2), output: { executionStatus: 'COMPLETED', outcome: 'PASS' } },
      { request: requestFor('reviewer', cycle2), output: { executionStatus: 'COMPLETED', outcome: 'PASS' } },
    ]);
    const phase2 = makeStack({ dbFile, llm: phase2LLM, taskId });

    const recovered = phase2.workflowStore.get(taskId);
    assert.deepEqual(
      { stage: recovered.stage, devCycle: recovered.devCycle, strategyEpoch: recovered.strategyEpoch },
      { stage: 'developer', devCycle: 2, strategyEpoch: 1 },
    );

    let lastOutcome;
    for (const expectedRole of ['developer', 'tester', 'reviewer']) {
      const current = phase2.workflowStore.get(taskId);
      assert.equal(current.stage, expectedRole);
      assert.equal(current.devCycle, 2);
      [lastOutcome] = await phase2.coordinator.tick([workFromState(taskId, current)]);
      assert.equal(lastOutcome.status, 'APPLIED');
    }
    finalizeIfRequested(phase2, taskId, lastOutcome);

    const finished = phase2.workflowStore.get(taskId);
    assert.equal(finished.status, 'SUCCEEDED');
    assert.equal(finished.devCycle, 2);
    assert.equal(finished.strategyEpoch, 1);

    const runs = phase2.runStore.list();
    assert.deepEqual(runs.map((run) => run.role), ['developer', 'tester', 'reviewer', 'developer', 'tester', 'reviewer']);
    assert.deepEqual(runs.map((run) => run.context.devCycle), [1, 1, 1, 2, 2, 2]);
    phase2LLM.assertExhausted();

    phase2.workflowStore.close();
    phase2.runStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
