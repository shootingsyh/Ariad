import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { V2Scheduler, partitionGraphs } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import { bootstrapProject, createPlanningFlow } from '../src/v2/project-bootstrap.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-v2-'));
  return { dir, file: path.join(dir, 'state.db') };
}

function roles() {
  const registry = new RoleRegistry();
  registry.register('developer', {
    prepare: ({ task }) => ({ provider: 'fake', prompt: `develop ${task.id}`, resources: ['gpu'] }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'tester', state: 'READY' }
      : { stage: 'developer', state: 'READY' },
  });
  registry.register('tester', {
    prepare: ({ task }) => ({ provider: 'fake', prompt: `test ${task.id}`, resources: ['gpu'] }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'reviewer', state: 'READY' }
      : { stage: 'developer', state: 'READY' },
  });
  registry.register('reviewer', {
    prepare: ({ task }) => ({ provider: 'fake', prompt: `review ${task.id}`, resources: [] }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'reviewer', state: 'DONE' }
      : { stage: 'developer', state: 'READY' },
  });
  registry.register('tech_lead', {
    prepare: ({ task }) => ({ provider: 'fake', prompt: `plan ${task.input?.purpose ?? task.id}`, resources: [] }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'tech_lead', state: 'DONE' }
      : { stage: 'tech_lead', state: 'READY' },
  });
  registry.register('pm', {
    sessionPolicy: 'persistent',
    prepare: ({ project, task }) => ({
      provider: 'fake',
      prompt: task?.input?.purpose ?? project.spec ?? '',
      sessionKey: project.pmBinding ?? project.id,
    }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'pm', state: 'DONE' }
      : { stage: 'pm', state: 'READY' },
  });
  return registry;
}

function fakeProvider() {
  let sequence = 0;
  const states = new Map();
  return {
    id: 'fake',
    starts: [],
    async start(spec) {
      const externalId = `fake-${++sequence}`;
      this.starts.push({ externalId, spec });
      states.set(externalId, { state: 'RUNNING' });
      return { externalId };
    },
    async poll(handle) {
      return states.get(handle.externalId) ?? { state: 'LOST' };
    },
    async cancel(handle) {
      states.set(handle.externalId, { state: 'CANCELLED' });
    },
    complete(externalId, result) {
      states.set(externalId, { state: 'COMPLETED', outcome: 'PASS', summary: 'done', ...result });
    },
  };
}

test('v2 drives one durable task through developer, tester, reviewer using task history only', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P1', spec: 'build it', pmBinding: 'pm-session-1' });
    store.createTask({ id: 'T1', projectId: 'P1', stage: 'developer' });

    const roleRegistry = roles();
    const provider = fakeProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({ gpu: 1 });
    const scheduler = new V2Scheduler({ store, roles: roleRegistry, providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });

    await scheduler.tick('P1');
    let task = store.getTask('T1');
    assert.equal(task.scope, 'delivery');
    assert.equal(task.state, 'WORKING');
    assert.equal(task.stage, 'developer');
    assert.deepEqual(resources.snapshot().map(x => x.owner), ['T1']);

    provider.complete(task.execution.externalId, { keyPoints: ['implemented'] });
    await supervisor.audit('P1');
    task = store.getTask('T1');
    assert.equal(task.state, 'RESULT_READY');
    assert.equal(task.history.length, 1);
    assert.equal(task.history[0].role, 'developer');

    await scheduler.tick('P1');
    task = store.getTask('T1');
    assert.equal(task.stage, 'tester');
    assert.equal(task.state, 'WORKING');

    provider.complete(task.execution.externalId);
    await supervisor.audit('P1');
    await scheduler.tick('P1');
    task = store.getTask('T1');
    assert.equal(task.stage, 'reviewer');
    assert.equal(task.state, 'WORKING');

    provider.complete(task.execution.externalId, { artifacts: ['review.txt'] });
    await supervisor.audit('P1');
    await scheduler.tick('P1');
    task = store.getTask('T1');
    assert.equal(task.state, 'DONE');
    assert.equal(task.history.filter(x => x.type === 'ROLE_RESULT').length, 3);
    assert.deepEqual(task.artifacts, ['review.txt']);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler follows dependency topology and one-GPU capacity', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P2' });
    store.createTask({ id: 'A', projectId: 'P2', stage: 'developer' });
    store.createTask({ id: 'B', projectId: 'P2', stage: 'developer' });
    store.createTask({ id: 'C', projectId: 'P2', stage: 'developer', dependsOn: ['A', 'B'] });

    const provider = fakeProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({ gpu: 1 });
    const scheduler = new V2Scheduler({ store, roles: roles(), providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });

    const first = await scheduler.tick('P2');
    assert.deepEqual(first.started, ['A']);
    assert.equal(store.getTask('B').state, 'READY');
    assert.equal(store.getTask('C').state, 'READY');

    let a = store.getTask('A');
    provider.complete(a.execution.externalId);
    await supervisor.audit('P2');
    await scheduler.tick('P2');
    a = store.getTask('A');
    assert.equal(a.stage, 'tester');
    assert.equal(a.state, 'WORKING');
    assert.equal(store.getTask('B').state, 'READY');
    assert.equal(store.getTask('C').state, 'READY');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retry count is derived from task history, not a durable counter', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P3' });
    let task = store.createTask({ id: 'T3', projectId: 'P3', stage: 'developer' });
    task = store.appendTaskHistory('T3', task.version, { type: 'ROLE_RESULT', role: 'developer', outcome: 'NOT_PASS' });
    task = store.appendTaskHistory('T3', task.version, { type: 'ROLE_RESULT', role: 'developer', outcome: 'PASS' });
    const attempts = task.history.filter(x => x.type === 'ROLE_RESULT' && x.role === 'developer').length;
    assert.equal(attempts, 2);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor recovers resource claims from durable WORKING tasks after restart', async () => {
  const { dir, file } = tempDb();
  try {
    const first = new SQLiteV2Store(file);
    first.createProject({ id: 'P4' });
    first.createTask({
      id: 'T4',
      projectId: 'P4',
      stage: 'developer',
      state: 'WORKING',
      execution: { provider: 'fake', externalId: 'ext-1', resources: ['gpu'] },
    });
    first.close();

    const second = new SQLiteV2Store(file);
    const providers = new ProviderRegistry();
    providers.register(fakeProvider());
    const resources = new ResourcePool({ gpu: 1 });
    const supervisor = new V2Supervisor({ store: second, providers, resources });
    supervisor.recover('P4');
    assert.deepEqual(resources.snapshot().map(x => x.owner), ['T4']);
    assert.equal(resources.claim(['gpu'], 'OTHER'), false);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('role definitions carry startup policy, including persistent PM sessions', () => {
  const role = roles().get('pm');
  const project = { id: 'P5', spec: 'brainstorm this', pmBinding: 'openclaw:agent:pm-1' };
  const spec = role.prepare({ project, task: null });
  assert.equal(role.sessionPolicy, 'persistent');
  assert.equal(spec.sessionKey, 'openclaw:agent:pm-1');
});

test('control tasks form independent ad-hoc graphs while delivery stays one graph', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P6' });
    store.createTask({ id: 'D1', projectId: 'P6', stage: 'developer' });
    store.createTask({ id: 'D2', projectId: 'P6', stage: 'developer', dependsOn: ['D1'] });
    store.createControlFlow({
      projectId: 'P6',
      flowId: 'plan-1',
      tasks: [
        { id: 'PLAN-TL', stage: 'tech_lead' },
        { id: 'PLAN-PM', stage: 'pm', dependsOn: ['PLAN-TL'] },
      ],
    });
    store.createControlFlow({
      projectId: 'P6',
      flowId: 'replan-2',
      tasks: [{ id: 'REPLAN-TL', stage: 'tech_lead' }],
    });

    const groups = partitionGraphs(store.listTasks('P6'));
    assert.deepEqual(groups.map(x => x.key), ['delivery', 'control:plan-1', 'control:replan-2']);
    assert.deepEqual(store.listTasks('P6', { scope: 'delivery' }).map(x => x.id), ['D1', 'D2']);
    assert.deepEqual(store.listControlFlows('P6').map(x => x.flowId), ['plan-1', 'replan-2']);

    assert.throws(() => store.createControlFlow({
      projectId: 'P6',
      flowId: 'bad',
      tasks: [{ id: 'BAD', stage: 'pm', dependsOn: ['D1'] }],
    }), /depends outside flow/);

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty project bootstrap welcomes PM without creating durable work', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P7', pmBinding: 'pm:p7' });
    const result = bootstrapProject({ store, projectId: 'P7', directoryEmpty: true });
    assert.equal(result.pmInvocation.kind, 'WELCOME');
    assert.equal(result.pmInvocation.sessionKey, 'pm:p7');
    assert.equal(result.controlFlow, null);
    assert.deepEqual(store.listTasks('P7'), []);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-empty project bootstrap creates restore/discover then PM review control flow', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P8', pmBinding: 'pm:p8' });
    const result = bootstrapProject({
      store,
      projectId: 'P8',
      directoryEmpty: false,
      flowId: 'bootstrap-1',
    });
    assert.equal(result.pmInvocation.kind, 'WELCOME_AND_RESTORE_STARTED');
    assert.equal(result.controlFlow.flowId, 'bootstrap-1');
    const tasks = store.listTasks('P8', { flowId: 'bootstrap-1' });
    assert.deepEqual(tasks.map(x => [x.id, x.stage, x.dependsOn]), [
      ['bootstrap-1:restore', 'tech_lead', []],
      ['bootstrap-1:review', 'pm', ['bootstrap-1:restore']],
    ]);
    assert.ok(tasks.every(x => x.scope === 'control'));
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM can open an ad-hoc planning flow without touching the delivery graph', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P9' });
    store.createTask({ id: 'FEATURE', projectId: 'P9', stage: 'developer' });
    const flow = createPlanningFlow({
      store,
      projectId: 'P9',
      flowId: 'plan-42',
      input: { request: 'add collaboration' },
    });
    assert.equal(flow.flowId, 'plan-42');
    assert.deepEqual(store.listTasks('P9', { scope: 'delivery' }).map(x => x.id), ['FEATURE']);
    assert.deepEqual(store.listTasks('P9', { flowId: 'plan-42' }).map(x => x.stage), ['tech_lead', 'pm']);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
