import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRegistry } from '../src/runtime-registry.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';
import { RuntimeExecutor } from '../src/runtime-executor.js';
import { InMemoryRunStore } from '../src/run-store.js';
import { WorkflowEngine } from '../src/workflow.js';

const completed = (outcome, result = null) => ({ outcome, result });

function makeExecutor(script, options = {}) {
  const registry = new RuntimeRegistry();
  const runtime = createFakeRuntimeAdapter({ script });
  registry.register('engineering', runtime);
  const runStore = new InMemoryRunStore();
  const executor = new RuntimeExecutor({
    registry,
    runStore,
    roleRuntimeMap: {
      developer: 'engineering',
      tester: 'engineering',
      reviewer: 'engineering',
      project_debugger: 'engineering',
      pm: 'engineering',
    },
    ...options,
  });
  return { executor, runStore, runtime };
}

test('runtime executor creates a first-class Run and drives it to completion', async () => {
  const { executor, runStore, runtime } = makeExecutor([
    completed('IMPLEMENTATION_READY', { artifact: 'build-1' }),
  ]);

  const result = await executor.run('developer', { taskId: 'T-1', strategyEpoch: 1, devCycle: 1 });

  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.outcome, 'IMPLEMENTATION_READY');
  assert.deepEqual(result.result, { artifact: 'build-1' });

  const [run] = runStore.list();
  assert.equal(run.taskId, 'T-1');
  assert.equal(run.role, 'developer');
  assert.equal(run.runtimeKey, 'engineering');
  assert.equal(run.runtimeId, 'fake');
  assert.equal(run.state, 'COMPLETED');
  assert.equal(run.attempt, 1);
  assert.ok(run.externalId.startsWith('fake:'));
  assert.deepEqual(runtime.calls.map(call => call.operation), ['start']);
});

test('workflow can execute end-to-end through RuntimeRegistry and fake runtime', async () => {
  const { executor, runStore } = makeExecutor([
    completed('IMPLEMENTATION_READY'),
    completed('PASS'),
    completed('PASS'),
  ]);

  const result = await new WorkflowEngine(executor).runFeature('F-runtime-1');

  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(runStore.list().map(run => run.role), ['developer', 'tester', 'reviewer']);
  assert.ok(runStore.list().every(run => run.state === 'COMPLETED'));
});

test('runtime execution failure is normalized without becoming a semantic rejection', async () => {
  const registry = new RuntimeRegistry();
  const runtime = {
    id: 'failing-runtime',
    config: {},
    async install() { return { state: 'INSTALLED' }; },
    async probe() { return { health: 'HEALTHY' }; },
    async start(request) { return { runtimeId: this.id, runId: request.runId, externalId: `ext:${request.runId}`, state: 'RUNNING' }; },
    async resume(request) { return this.start(request); },
    async poll() { return { state: 'FAILED', failure: 'MODEL_DOWN' }; },
    async cancel() { return { state: 'CANCELLED' }; },
  };
  registry.register('engineering', runtime);
  const runStore = new InMemoryRunStore();
  const executor = new RuntimeExecutor({ registry, runStore, roleRuntimeMap: { developer: 'engineering' } });

  const result = await executor.run('developer', { taskId: 'T-fail' });

  assert.equal(result.executionStatus, 'FAILED');
  assert.equal(result.failure, 'MODEL_DOWN');
  assert.equal(runStore.list()[0].state, 'FAILED');
});

test('a missing role-to-runtime mapping fails before creating a Run', async () => {
  const registry = new RuntimeRegistry();
  registry.register('engineering', createFakeRuntimeAdapter());
  const runStore = new InMemoryRunStore();
  const executor = new RuntimeExecutor({ registry, runStore, roleRuntimeMap: {} });

  await assert.rejects(() => executor.run('developer', { taskId: 'T-missing' }), /no runtime configured for role developer/);
  assert.equal(runStore.list().length, 0);
});

test('Run ids are unique and attempts increment per task and role', async () => {
  const { executor, runStore } = makeExecutor([
    completed('IMPLEMENTATION_READY'),
    completed('IMPLEMENTATION_READY'),
  ]);

  await executor.run('developer', { taskId: 'T-repeat' });
  await executor.run('developer', { taskId: 'T-repeat' });

  const runs = runStore.list();
  assert.notEqual(runs[0].id, runs[1].id);
  assert.deepEqual(runs.map(run => run.attempt), [1, 2]);
});


test('runtime executor is bounded by wall-clock time rather than a fixed poll count', async () => {
  const registry = new RuntimeRegistry();
  let polls = 0;
  const runtime = {
    id: 'many-polls-runtime',
    config: {},
    async install() { return { state: 'INSTALLED' }; },
    async probe() { return { health: 'HEALTHY' }; },
    async start(request) { return { runtimeId: this.id, runId: request.runId, externalId: 'many-polls', state: 'RUNNING' }; },
    async resume(request) { return this.start(request); },
    async poll() {
      polls += 1;
      if (polls <= 450) return { state: 'RUNNING' };
      return { state: 'COMPLETED', outcome: 'PASS', result: { polls } };
    },
    async cancel() { return { state: 'CANCELLED' }; },
  };
  registry.register('engineering', runtime);
  const runStore = new InMemoryRunStore();
  const executor = new RuntimeExecutor({
    registry,
    runStore,
    roleRuntimeMap: { tester: 'engineering' },
    maxDurationMs: 2_000,
    pollIntervalMs: 0,
  });

  const result = await executor.run('tester', { taskId: 'T-many-polls' });

  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.result.polls, 451);
  assert.equal(runStore.list()[0].state, 'COMPLETED');
});

test('runtime executor marks and cancels a run when its wall-clock deadline expires', async () => {
  const registry = new RuntimeRegistry();
  let cancelled = false;
  const runtime = {
    id: 'slow-runtime',
    config: {},
    async install() { return { state: 'INSTALLED' }; },
    async probe() { return { health: 'HEALTHY' }; },
    async start(request) { return { runtimeId: this.id, runId: request.runId, externalId: 'slow', state: 'RUNNING' }; },
    async resume(request) { return this.start(request); },
    async poll() {
      await new Promise((resolve) => setTimeout(resolve, 6));
      return { state: 'RUNNING' };
    },
    async cancel() { cancelled = true; return { state: 'CANCELLED' }; },
  };
  registry.register('engineering', runtime);
  const runStore = new InMemoryRunStore();
  const executor = new RuntimeExecutor({
    registry,
    runStore,
    roleRuntimeMap: { tech_lead: 'engineering' },
    maxDurationMs: 10,
    pollIntervalMs: 0,
  });

  const result = await executor.run('tech_lead', { taskId: 'T-timeout' });

  assert.equal(result.executionStatus, 'FAILED');
  assert.equal(result.failure, 'POLL_TIMEOUT');
  assert.equal(cancelled, true);
  assert.equal(runStore.list()[0].state, 'FAILED');
  assert.equal(runStore.list()[0].failure, 'POLL_TIMEOUT');
});
