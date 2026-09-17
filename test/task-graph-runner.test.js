import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskGraph } from '../src/task-graph.js';
import { WorkBuilder } from '../src/work-builder.js';
import { GraphRunner } from '../src/graph-runner.js';
import { Scheduler } from '../src/scheduler.js';
import { Coordinator } from '../src/coordinator.js';
import { TransitionEngine } from '../src/transition-engine.js';
import { WorkflowTransitionService } from '../src/workflow-transition-service.js';
import { EffectExecutor } from '../src/effect-executor.js';
import { SQLiteWorkflowStateStore } from '../src/sqlite-workflow-state-store.js';
import { ReliabilityExecutionExecutor } from '../src/reliability-execution-executor.js';

function withState(tasks, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-graph-'));
  const store = new SQLiteWorkflowStateStore(join(dir, 'state.db'));
  for (const task of tasks) store.create(task.id);
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
}

function buildSystem({ tasks, dispatch, resourceResolver = () => [], resourceManager = null }) {
  const graph = new TaskGraph(tasks);
  return withState(tasks, async stateStore => {
    const transitions = new WorkflowTransitionService({ stateStore, engine: new TransitionEngine() });
    const effects = new EffectExecutor({ transitionService: transitions, finalizeSourceControl: async () => ({ ok: true }) });
    const manager = resourceManager ?? {
      tryAcquire() { return { async release() {} }; },
    };
    const scheduler = new Scheduler({
      resourceManager: manager,
      isRuntimeHealthy: () => true,
      dispatch,
    });
    const coordinator = new Coordinator({
      scheduler,
      applyExecutionResult: (work, result) => transitions.apply(work, result),
      effectExecutor: effects,
    });
    const workBuilder = new WorkBuilder({
      graph,
      stateStore,
      roleRuntimeMap: { developer: 'mock', tester: 'mock', reviewer: 'mock', project_debugger: 'mock', pm: 'mock' },
      resourceResolver,
    });
    const runner = new GraphRunner({ graph, workBuilder, coordinator, stateStore, maxTicks: 50 });
    return fnSystemResult(await runner.run(), stateStore);
  });
}

let systemAssertions = null;
function fnSystemResult(result, stateStore) {
  return systemAssertions(result, stateStore);
}

function completed(outcome = 'PASS') {
  return { executionStatus: 'COMPLETED', outcome };
}

test('diamond graph unblocks tasks only after dependencies succeed and runs to completion', async () => {
  const tasks = [
    { id: 'A', dependsOn: [] },
    { id: 'B', dependsOn: ['A'] },
    { id: 'C', dependsOn: ['A'] },
    { id: 'D', dependsOn: ['B', 'C'] },
  ];
  const calls = [];
  systemAssertions = (result) => {
    assert.equal(result.status, 'SUCCEEDED');
    for (const task of tasks) assert.equal(result.states[task.id].status, 'SUCCEEDED');
    const firstTickTasks = new Set(result.history[0].ready.map(work => work.taskId));
    assert.deepEqual([...firstTickTasks], ['A']);
    const firstB = calls.findIndex(call => call.taskId === 'B');
    const firstC = calls.findIndex(call => call.taskId === 'C');
    const lastA = calls.map((x, i) => x.taskId === 'A' ? i : -1).filter(i => i >= 0).at(-1);
    assert.ok(firstB > lastA && firstC > lastA);
    const firstD = calls.findIndex(call => call.taskId === 'D');
    const lastB = calls.map((x, i) => x.taskId === 'B' ? i : -1).filter(i => i >= 0).at(-1);
    const lastC = calls.map((x, i) => x.taskId === 'C' ? i : -1).filter(i => i >= 0).at(-1);
    assert.ok(firstD > lastB && firstD > lastC);
    return result;
  };
  await buildSystem({
    tasks,
    dispatch: async work => {
      calls.push({ taskId: work.taskId, role: work.role, devCycle: work.context.devCycle });
      return completed('PASS');
    },
  });
});

test('graph tolerates a resource block and reviewer rejection, then finishes after retry', async () => {
  const tasks = [
    { id: 'A', dependsOn: [] },
    { id: 'B', dependsOn: ['A'] },
    { id: 'C', dependsOn: ['B'] },
  ];
  const calls = [];
  const reviewerCalls = new Map();
  let blockedGpuOnce = false;
  const resourceManager = {
    tryAcquire(resource) {
      if (resource === 'gpu' && !blockedGpuOnce) {
        blockedGpuOnce = true;
        return null;
      }
      return { async release() {} };
    },
  };
  systemAssertions = (result) => {
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(blockedGpuOnce, true);
    assert.equal(result.states.C.devCycle, 2);
    const cDeveloperCycles = calls.filter(x => x.taskId === 'C' && x.role === 'developer').map(x => x.devCycle);
    assert.deepEqual(cDeveloperCycles, [1, 2]);
    const waiting = result.history.flatMap(x => x.outcomes).filter(x => x.status === 'WAITING_RESOURCE');
    assert.equal(waiting.length, 1);
    return result;
  };
  await buildSystem({
    tasks,
    resourceManager,
    resourceResolver: ({ task, state }) => task.id === 'B' && state.stage === 'tester' ? ['gpu'] : [],
    dispatch: async work => {
      calls.push({ taskId: work.taskId, role: work.role, devCycle: work.context.devCycle });
      if (work.role === 'reviewer' && work.taskId === 'C') {
        const n = (reviewerCalls.get('C') ?? 0) + 1;
        reviewerCalls.set('C', n);
        return completed(n === 1 ? 'NOT_PASS' : 'PASS');
      }
      return completed('PASS');
    },
  });
});

test('system execution failure is recovered and retried without advancing business cycle, then graph completes', async () => {
  const tasks = [
    { id: 'A', dependsOn: [] },
    { id: 'B', dependsOn: ['A'] },
  ];
  const attempts = [];
  let failed = false;
  const rawExecutor = {
    async run(role, context) {
      attempts.push({ taskId: context.taskId, role, devCycle: context.devCycle });
      if (!failed && context.taskId === 'A' && role === 'developer') {
        failed = true;
        return { executionStatus: 'FAILED', failure: 'synthetic crash', runId: 'RUN-FAIL-1' };
      }
      return completed('PASS');
    },
  };
  const resilient = new ReliabilityExecutionExecutor({ executor: rawExecutor, maxRecoveries: 2 });
  systemAssertions = (result) => {
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.states.A.devCycle, 1);
    assert.equal(result.states.B.devCycle, 1);
    const aDeveloper = attempts.filter(x => x.taskId === 'A' && x.role === 'developer');
    assert.equal(aDeveloper.length, 2);
    assert.deepEqual(aDeveloper.map(x => x.devCycle), [1, 1]);
    const firstB = attempts.findIndex(x => x.taskId === 'B');
    const lastA = attempts.map((x, i) => x.taskId === 'A' ? i : -1).filter(i => i >= 0).at(-1);
    assert.ok(firstB > lastA);
    return result;
  };
  await buildSystem({
    tasks,
    dispatch: work => resilient.run(work.role, work.context),
  });
});

test('task graph rejects cycles before any work is queued', () => {
  assert.throws(() => new TaskGraph([
    { id: 'A', dependsOn: ['B'] },
    { id: 'B', dependsOn: ['A'] },
  ]), /cycle/);
});
