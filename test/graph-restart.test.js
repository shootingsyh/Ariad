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

const tasks = [
  { id: 'A', dependsOn: [] },
  { id: 'B', dependsOn: [] },
  { id: 'C', dependsOn: [] },
  { id: 'D', dependsOn: ['A'] },
  { id: 'E', dependsOn: ['A', 'B'] },
  { id: 'F', dependsOn: ['B', 'C'] },
  { id: 'G', dependsOn: ['C'] },
  { id: 'H', dependsOn: ['D', 'E'] },
  { id: 'I', dependsOn: ['E', 'F'] },
  { id: 'J', dependsOn: ['F', 'G'] },
  { id: 'K', dependsOn: ['H', 'I'] },
  { id: 'L', dependsOn: ['I', 'J'] },
  { id: 'M', dependsOn: ['K', 'L'] },
];

function completed(outcome = 'PASS') {
  return { executionStatus: 'COMPLETED', outcome };
}

function buildStack({ dbFile, graph, dispatch, maxTicks }) {
  const stateStore = new SQLiteWorkflowStateStore(dbFile);
  const transitions = new WorkflowTransitionService({ store: stateStore, engine: new TransitionEngine() });
  const effects = new EffectExecutor({
    transitionService: transitions,
    finalizeSourceControl: async () => ({ ok: true }),
  });
  const resourceManager = {
    tryAcquire() { return { async release() {} }; },
  };
  const scheduler = new Scheduler({
    resourceManager,
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
    roleRuntimeMap: {
      developer: 'mock', tester: 'mock', reviewer: 'mock', project_debugger: 'mock', pm: 'mock',
    },
  });
  const runner = new GraphRunner({ graph, workBuilder, coordinator, stateStore, maxTicks });
  return { stateStore, runner };
}

test('whole task graph resumes after process-style restart without rerunning completed work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-graph-restart-'));
  const dbFile = join(dir, 'state.db');
  const graph = new TaskGraph(tasks);
  const phase1Calls = [];
  const phase2Calls = [];
  const reviewerCounts = new Map();

  let phase1Store;
  let phase2Store;
  try {
    phase1Store = new SQLiteWorkflowStateStore(dbFile);
    for (const task of tasks) phase1Store.create(task.id);
    phase1Store.close();
    phase1Store = null;

    const phase1 = buildStack({
      dbFile,
      graph,
      maxTicks: 5,
      dispatch: async work => {
        phase1Calls.push({ taskId: work.taskId, role: work.role, devCycle: work.context.devCycle });
        return completed('PASS');
      },
    });
    phase1Store = phase1.stateStore;
    const partial = await phase1.runner.run();
    assert.equal(partial.status, 'MAX_TICKS');

    const completedBeforeRestart = new Set(
      tasks.filter(task => partial.states[task.id].status === 'SUCCEEDED').map(task => task.id),
    );
    assert.ok(completedBeforeRestart.size > 0, 'restart should happen after some tasks are complete');
    assert.ok(completedBeforeRestart.size < tasks.length, 'restart should happen before the graph is complete');

    const stateBeforeRestart = Object.fromEntries(
      tasks.map(task => [task.id, partial.states[task.id]]),
    );

    phase1Store.close();
    phase1Store = null;

    const phase2 = buildStack({
      dbFile,
      graph,
      maxTicks: 50,
      dispatch: async work => {
        phase2Calls.push({ taskId: work.taskId, role: work.role, devCycle: work.context.devCycle });
        if (work.taskId === 'I' && work.role === 'reviewer') {
          const count = (reviewerCounts.get('I') ?? 0) + 1;
          reviewerCounts.set('I', count);
          return completed(count === 1 ? 'NOT_PASS' : 'PASS');
        }
        return completed('PASS');
      },
    });
    phase2Store = phase2.stateStore;
    const result = await phase2.runner.run();

    assert.equal(result.status, 'SUCCEEDED');
    for (const task of tasks) assert.equal(result.states[task.id].status, 'SUCCEEDED');

    for (const taskId of completedBeforeRestart) {
      assert.equal(
        phase2Calls.some(call => call.taskId === taskId),
        false,
        `completed task ${taskId} must not execute again after restart`,
      );
    }

    for (const task of tasks) {
      if (completedBeforeRestart.has(task.id)) continue;
      const before = stateBeforeRestart[task.id];
      const firstAfter = phase2Calls.find(call => call.taskId === task.id);
      if (before.status === 'RUNNING') {
        assert.ok(firstAfter, `unfinished task ${task.id} should eventually resume`);
        assert.equal(firstAfter.role, before.stage, `task ${task.id} should resume from durable stage`);
        assert.equal(firstAfter.devCycle, before.devCycle, `task ${task.id} should resume durable devCycle`);
      }
    }

    assert.equal(result.states.I.devCycle, 2, 'business rejection after restart should advance only I to cycle 2');
    assert.deepEqual(
      phase2Calls.filter(call => call.taskId === 'I' && call.role === 'developer').map(call => call.devCycle),
      [1, 2],
      'I should start its durable cycle 1 after restart, then re-enter developer for business cycle 2',
    );

    const allCalls = [...phase1Calls.map(call => ({ ...call, phase: 1 })), ...phase2Calls.map(call => ({ ...call, phase: 2 }))];
    for (const task of tasks) {
      const firstIndex = allCalls.findIndex(call => call.taskId === task.id);
      for (const dep of task.dependsOn) {
        const depLastIndex = allCalls.map((call, index) => call.taskId === dep ? index : -1).filter(index => index >= 0).at(-1);
        assert.ok(firstIndex > depLastIndex, `${task.id} must not begin before dependency ${dep} has finished all work`);
      }
    }
  } finally {
    if (phase1Store) phase1Store.close();
    if (phase2Store) phase2Store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
