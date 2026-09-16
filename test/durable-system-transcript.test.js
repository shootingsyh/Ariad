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
import { ScriptedLLM } from '../src/llm/scripted.js';
import { LLMWorkflowRoleExecutor } from '../src/llm/workflow-role-executor.js';
import { LLMRuntimeAdapter } from '../src/adapters/llm-runtime.js';

function requestFor(role, context) {
  return {
    json: true,
    messages: [
      {
        role: 'system',
        content: `You are Ariad's ${role} role. Return only one JSON object. Do not wrap it in markdown. Preserve the distinction between execution failure and business outcome.`,
      },
      { role: 'user', content: JSON.stringify(context) },
    ],
  };
}

function makeStack({ dbFile, llm, taskId }) {
  const runStore = new SQLiteRunStore(dbFile);
  const workflowStore = new SQLiteWorkflowStateStore(dbFile);
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
    applyExecutionResult: async (work, result) => {
      const current = workflowStore.get(taskId);
      if (result.executionStatus !== 'COMPLETED') return workflowStore.update(taskId, current.version, { status: 'PAUSED_SYSTEM' });
      if (work.role === 'developer') return workflowStore.update(taskId, current.version, { stage: 'tester' });
      if (work.role === 'tester') {
        if (result.outcome === 'PASS') return workflowStore.update(taskId, current.version, { stage: 'reviewer' });
        return workflowStore.update(taskId, current.version, { stage: 'developer', devCycle: current.devCycle + 1 });
      }
      if (work.role === 'reviewer') {
        if (result.outcome === 'PASS') return workflowStore.update(taskId, current.version, { status: 'SUCCEEDED' });
        return workflowStore.update(taskId, current.version, { stage: 'developer', devCycle: current.devCycle + 1 });
      }
      throw new Error(`unexpected role ${work.role}`);
    },
  });
  return { runStore, workflowStore, coordinator };
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

    // Simulated Ariad process crash/restart: all in-memory runtime/LLM/coordinator objects are discarded.
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
