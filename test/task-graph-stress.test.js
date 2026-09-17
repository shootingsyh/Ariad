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

const tasks = [
  { id: 'T01', dependsOn: [] },
  { id: 'T02', dependsOn: [] },
  { id: 'T03', dependsOn: [] },
  { id: 'T04', dependsOn: ['T01'] },
  { id: 'T05', dependsOn: ['T01'] },
  { id: 'T06', dependsOn: ['T02'] },
  { id: 'T07', dependsOn: ['T02', 'T03'] },
  { id: 'T08', dependsOn: ['T03'] },
  { id: 'T09', dependsOn: ['T04', 'T05'] },
  { id: 'T10', dependsOn: ['T05', 'T06'] },
  { id: 'T11', dependsOn: ['T06', 'T07'] },
  { id: 'T12', dependsOn: ['T07', 'T08'] },
  { id: 'T13', dependsOn: ['T09', 'T10'] },
  { id: 'T14', dependsOn: ['T10', 'T11'] },
  { id: 'T15', dependsOn: ['T11', 'T12'] },
  { id: 'T16', dependsOn: ['T13', 'T14', 'T15'] },
];

function completed(outcome = 'PASS') {
  return { executionStatus: 'COMPLETED', outcome };
}

function keyOf({ taskId, role, devCycle }) {
  return `${taskId}:${role}:cycle${devCycle}`;
}

test('stress graph converges through dependency blocks, runtime blocks, GPU waits, business retries, and system recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-stress-graph-'));
  const store = new SQLiteWorkflowStateStore(join(dir, 'state.db'));
  try {
    for (const task of tasks) store.create(task.id);

    const graph = new TaskGraph(tasks);
    const transitions = new WorkflowTransitionService({ store, engine: new TransitionEngine() });

    let sequence = 0;
    const finalizedAt = new Map();
    const effects = new EffectExecutor({
      transitionService: transitions,
      finalizeSourceControl: async ({ taskId }) => {
        finalizedAt.set(taskId, ++sequence);
        return { ok: true };
      },
    });

    const gpuTasks = new Set(['T04', 'T07', 'T10', 'T12', 'T14', 'T16']);
    let gpuDenialsRemaining = 5;
    let activeGpu = 0;
    let maxActiveGpu = 0;
    const resourceManager = {
      tryAcquire(resource) {
        if (resource !== 'gpu') return { async release() {} };
        if (gpuDenialsRemaining > 0) {
          gpuDenialsRemaining -= 1;
          return null;
        }
        assert.equal(activeGpu, 0, 'GPU capacity=1 must never have two active leases');
        activeGpu += 1;
        maxActiveGpu = Math.max(maxActiveGpu, activeGpu);
        let released = false;
        return {
          async release() {
            if (released) return;
            released = true;
            activeGpu -= 1;
          },
        };
      },
    };

    let testerHealthBlocksRemaining = 4;
    const healthChecks = [];
    const isRuntimeHealthy = runtimeKey => {
      healthChecks.push(runtimeKey);
      if (runtimeKey === 'tester-runtime' && testerHealthBlocksRemaining > 0) {
        testerHealthBlocksRemaining -= 1;
        return false;
      }
      return true;
    };

    const attempts = [];
    const dispatches = [];
    const logicalDispatchCounts = new Map();
    const reviewerCounts = new Map();
    const failedOnce = new Set();
    const rawExecutor = {
      async run(role, context) {
        const attempt = {
          taskId: context.taskId,
          role,
          devCycle: context.devCycle,
          sequence: ++sequence,
        };
        attempts.push(attempt);

        const systemFailureKey = `${context.taskId}:${role}`;
        if ((systemFailureKey === 'T05:developer' || systemFailureKey === 'T11:tester') && !failedOnce.has(systemFailureKey)) {
          failedOnce.add(systemFailureKey);
          return {
            executionStatus: 'FAILED',
            failure: `synthetic failure for ${systemFailureKey}`,
            runId: `RUN-FAIL-${context.taskId}-${role}`,
          };
        }

        if (role === 'reviewer' && (context.taskId === 'T07' || context.taskId === 'T14')) {
          const count = (reviewerCounts.get(context.taskId) ?? 0) + 1;
          reviewerCounts.set(context.taskId, count);
          return completed(count === 1 ? 'NOT_PASS' : 'PASS');
        }
        return completed('PASS');
      },
    };
    const resilient = new ReliabilityExecutionExecutor({ executor: rawExecutor, maxRecoveries: 2 });

    const scheduler = new Scheduler({
      resourceManager,
      isRuntimeHealthy,
      dispatch: async work => {
        dispatches.push({
          taskId: work.taskId,
          role: work.role,
          devCycle: work.context.devCycle,
          sequence: ++sequence,
        });
        const logicalKey = keyOf({ taskId: work.taskId, role: work.role, devCycle: work.context.devCycle });
        logicalDispatchCounts.set(logicalKey, (logicalDispatchCounts.get(logicalKey) ?? 0) + 1);
        return resilient.run(work.role, work.context);
      },
    });

    const coordinator = new Coordinator({
      scheduler,
      applyExecutionResult: (work, result) => transitions.apply(work, result),
      effectExecutor: effects,
    });
    const workBuilder = new WorkBuilder({
      graph,
      stateStore: store,
      roleRuntimeMap: {
        developer: 'developer-runtime',
        tester: 'tester-runtime',
        reviewer: 'reviewer-runtime',
        project_debugger: 'debugger-runtime',
        pm: 'pm-runtime',
      },
      resourceResolver: ({ task, state }) => gpuTasks.has(task.id) && state.stage === 'tester' ? ['gpu'] : [],
    });
    const runner = new GraphRunner({ graph, workBuilder, coordinator, stateStore: store, maxTicks: 120 });

    const result = await runner.run();

    assert.equal(result.status, 'SUCCEEDED');
    assert.ok(result.ticks < 120, 'graph must converge before maxTicks');
    assert.equal(activeGpu, 0, 'all GPU leases must be released');
    assert.equal(maxActiveGpu, 1, 'stress test must actually exercise the single GPU lease');
    assert.equal(gpuDenialsRemaining, 0, 'stress test must exercise resource waiting');
    assert.equal(testerHealthBlocksRemaining, 0, 'stress test must exercise temporary runtime unhealthiness');

    const waitingResource = result.history.flatMap(entry => entry.outcomes).filter(outcome => outcome.status === 'WAITING_RESOURCE');
    const blockedRuntime = result.history.flatMap(entry => entry.outcomes).filter(outcome => outcome.status === 'BLOCKED_RUNTIME');
    assert.ok(waitingResource.length >= 5, 'expected repeated GPU resource waits');
    assert.ok(blockedRuntime.length >= 4, 'expected temporary tester runtime blocks');

    for (const task of tasks) {
      assert.equal(result.states[task.id].status, 'SUCCEEDED', `${task.id} must finish`);
      assert.ok(finalizedAt.has(task.id), `${task.id} must reach source-control finalization`);
      const taskDispatches = dispatches.filter(item => item.taskId === task.id);
      assert.ok(taskDispatches.length >= 3, `${task.id} must run developer/tester/reviewer`);
    }

    assert.equal(result.states.T07.devCycle, 2);
    assert.equal(result.states.T14.devCycle, 2);
    assert.deepEqual(
      dispatches.filter(item => item.taskId === 'T07' && item.role === 'developer').map(item => item.devCycle),
      [1, 2],
    );
    assert.deepEqual(
      dispatches.filter(item => item.taskId === 'T14' && item.role === 'developer').map(item => item.devCycle),
      [1, 2],
    );

    const t05DeveloperAttempts = attempts.filter(item => item.taskId === 'T05' && item.role === 'developer');
    const t11TesterAttempts = attempts.filter(item => item.taskId === 'T11' && item.role === 'tester');
    assert.deepEqual(t05DeveloperAttempts.map(item => item.devCycle), [1, 1], 'system retry must stay in the same business cycle');
    assert.deepEqual(t11TesterAttempts.map(item => item.devCycle), [1, 1], 'system retry must stay in the same business cycle');
    assert.equal(result.states.T05.devCycle, 1);
    assert.equal(result.states.T11.devCycle, 1);

    for (const task of tasks) {
      if (task.dependsOn.length === 0) continue;
      const firstDispatch = dispatches.find(item => item.taskId === task.id);
      assert.ok(firstDispatch, `${task.id} must be dispatched`);
      for (const dependency of task.dependsOn) {
        assert.ok(
          finalizedAt.get(dependency) < firstDispatch.sequence,
          `${task.id} must not start before dependency ${dependency} is fully finalized`,
        );
      }
    }

    for (const [logicalKey, count] of logicalDispatchCounts) {
      assert.equal(count, 1, `logical work ${logicalKey} must not be dispatched twice`);
    }

    const expectedCycle2 = new Set(['T07', 'T14']);
    for (const task of tasks) {
      const state = result.states[task.id];
      assert.equal(state.devCycle, expectedCycle2.has(task.id) ? 2 : 1, `${task.id} has unexpected business retry count`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
