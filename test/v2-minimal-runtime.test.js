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
import { buildExecutionGraph } from '../src/v2/execution-graph.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import { bootstrapProject, createPlanningFlow } from '../src/v2/project-bootstrap.js';
import { TECH_LEAD_PLAN_SCHEMA, validateTechLeadPlan } from '../src/v2/tech-lead-plan.js';
import { buildTechLeadPrompt } from '../src/v2/tech-lead-prompt.js';

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
    assert.equal(result.planningRequest, null);
    assert.deepEqual(store.listTasks('P7'), []);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-empty project bootstrap queues restore planning work instead of creating a competing control graph', () => {
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
    assert.equal(result.pmInvocation.kind, 'WELCOME_AND_PLANNING_QUEUED');
    assert.equal(result.planningRequest.id, 'bootstrap-1:restore');
    assert.equal(result.planningRequest.state, 'PENDING');
    assert.deepEqual(store.listTasks('P8'), []);
    assert.equal(store.hasUnplannedPlanningRequests('P8'), true);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM appends planning requests without creating separate plan/replan graphs', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P9' });
    store.createTask({ id: 'FEATURE', projectId: 'P9', stage: 'developer' });
    const result = createPlanningFlow({
      store,
      projectId: 'P9',
      flowId: 'plan-42',
      input: { request: 'add collaboration' },
    });
    assert.equal(result.planningRequest.id, 'plan-42');
    assert.equal(result.planningRequest.state, 'PENDING');
    assert.deepEqual(store.listTasks('P9', { scope: 'delivery' }).map(x => x.id), ['FEATURE']);
    assert.equal(store.listTasks('P9', { scope: 'control' }).length, 0);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('parent-child hierarchy becomes a virtual child-to-parent execution dependency', () => {
  const tasks = [
    { id: 'ROOT', scope: 'delivery', state: 'READY' },
    { id: 'FEATURE', scope: 'delivery', parentId: 'ROOT', state: 'READY' },
    { id: 'LEAF', scope: 'delivery', parentId: 'FEATURE', state: 'READY' },
  ];

  let graph = buildExecutionGraph(tasks);
  assert.deepEqual(graph.prerequisitesOf('ROOT'), ['FEATURE']);
  assert.deepEqual(graph.prerequisitesOf('FEATURE'), ['LEAF']);
  assert.deepEqual(graph.dependentsOf('LEAF'), ['FEATURE']);
  assert.equal(graph.isRunnable(tasks[0]), false);
  assert.equal(graph.isRunnable(tasks[1]), false);
  assert.equal(graph.isRunnable(tasks[2]), true);

  const progressed = tasks.map(task => task.id === 'LEAF' ? { ...task, state: 'DONE' } : task);
  graph = buildExecutionGraph(progressed);
  assert.equal(graph.isRunnable(graph.byId.get('FEATURE')), true);
  assert.equal(graph.isRunnable(graph.byId.get('ROOT')), false);
});

test('scheduler prefers runnable task with largest downstream unblock impact', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P10' });

    store.createTask({ id: 'BACKEND', projectId: 'P10', stage: 'developer' });
    store.createTask({ id: 'INTERFACE', projectId: 'P10', stage: 'developer', parentId: 'BACKEND' });
    store.createTask({ id: 'CONNECTION', projectId: 'P10', stage: 'developer', parentId: 'BACKEND', dependsOn: ['INTERFACE'] });

    store.createTask({ id: 'UI', projectId: 'P10', stage: 'developer' });
    store.createTask({ id: 'DRAWING', projectId: 'P10', stage: 'developer', parentId: 'UI' });
    store.createTask({ id: 'LIST-BACKEND', projectId: 'P10', stage: 'developer', parentId: 'UI', dependsOn: ['INTERFACE'] });

    store.createTask({ id: 'INIT', projectId: 'P10', stage: 'developer', dependsOn: ['INTERFACE'] });
    store.createTask({ id: 'LOGIN', projectId: 'P10', stage: 'developer', dependsOn: ['INTERFACE'] });

    const provider = fakeProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({ gpu: 1 });
    const scheduler = new V2Scheduler({ store, roles: roles(), providers, resources });

    const graph = buildExecutionGraph(store.listTasks('P10'));
    assert.ok(graph.downstreamImpact('INTERFACE') > graph.downstreamImpact('DRAWING'));

    const result = await scheduler.tick('P10');
    assert.deepEqual(result.started, ['INTERFACE']);
    assert.equal(store.getTask('DRAWING').state, 'READY');
    assert.equal(store.getTask('INTERFACE').state, 'WORKING');

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('Tech Lead v2 plan validator accepts a tree with precise cross-branch dependencies', () => {
  const plan = {
    version: 2,
    projectSummary: 'Todo app',
    rootTaskId: 'project-done',
    tasks: [
      {
        id: 'project-done',
        title: 'Todo app complete',
        intent: 'Integrate all major areas and validate whole-project completion.',
        parentId: null,
        dependsOn: [],
        acceptanceCriteria: ['Whole app passes final acceptance.'],
        testStrategy: 'Run project-wide E2E and acceptance checks.',
      },
      {
        id: 'backend',
        title: 'Backend',
        intent: 'Provide durable data access.',
        parentId: 'project-done',
        dependsOn: [],
        acceptanceCriteria: ['Backend integration is complete.'],
        testStrategy: 'Run backend integration tests.',
      },
      {
        id: 'dao-interface',
        title: 'DAO interface',
        intent: 'Define the stable data-access contract.',
        parentId: 'backend',
        dependsOn: [],
        acceptanceCriteria: ['Consumers can compile against the contract.'],
        testStrategy: 'Run contract tests against fake and real implementations.',
      },
      {
        id: 'ui',
        title: 'UI',
        intent: 'Provide user-facing todo workflows.',
        parentId: 'project-done',
        dependsOn: [],
        acceptanceCriteria: ['Primary UI flows work.'],
        testStrategy: 'Run UI integration tests.',
      },
      {
        id: 'list-backend',
        title: 'List backend integration',
        intent: 'Connect list behavior to the DAO contract.',
        parentId: 'ui',
        dependsOn: ['dao-interface'],
        acceptanceCriteria: ['List loads through the DAO contract.'],
        testStrategy: 'Run list integration against fake DAO.',
      },
    ],
  };

  const result = validateTechLeadPlan(plan);
  assert.equal(result.ok, true);
  assert.equal(result.plan.tasks.length, 5);
  assert.equal(result.plan.rootTaskId, 'project-done');
});

test('Tech Lead v2 plan validator rejects multiple logical roots', () => {
  const plan = {
    version: 2,
    projectSummary: 'bad',
    rootTaskId: 'A',
    tasks: [
      { id: 'A', title: 'A', intent: 'A', parentId: null, dependsOn: [], acceptanceCriteria: ['a'], testStrategy: 'a' },
      { id: 'B', title: 'B', intent: 'B', parentId: null, dependsOn: [], acceptanceCriteria: ['b'], testStrategy: 'b' },
    ],
  };
  assert.throws(() => validateTechLeadPlan(plan), /exactly one logical root/);
});

test('Tech Lead v2 plan validator rejects redundant parent dependency', () => {
  const plan = {
    version: 2,
    projectSummary: 'bad',
    rootTaskId: 'ROOT',
    tasks: [
      { id: 'ROOT', title: 'Root', intent: 'root', parentId: null, dependsOn: [], acceptanceCriteria: ['root'], testStrategy: 'root' },
      { id: 'CHILD', title: 'Child', intent: 'child', parentId: 'ROOT', dependsOn: ['ROOT'], acceptanceCriteria: ['child'], testStrategy: 'child' },
    ],
  };
  assert.throws(() => validateTechLeadPlan(plan), /must not repeat parent\/child ordering/);
});

test('Tech Lead v2 plan validator catches cycle created by explicit plus virtual hierarchy edges', () => {
  const plan = {
    version: 2,
    projectSummary: 'cycle',
    rootTaskId: 'ROOT',
    tasks: [
      { id: 'ROOT', title: 'Root', intent: 'root', parentId: null, dependsOn: [], acceptanceCriteria: ['root'], testStrategy: 'root' },
      { id: 'A', title: 'A', intent: 'a', parentId: 'ROOT', dependsOn: [], acceptanceCriteria: ['a'], testStrategy: 'a' },
      { id: 'B', title: 'B', intent: 'b', parentId: 'A', dependsOn: ['ROOT'], acceptanceCriteria: ['b'], testStrategy: 'b' },
    ],
  };
  assert.throws(() => validateTechLeadPlan(plan), /execution graph contains a cycle/);
});

test('Tech Lead prompt explicitly separates decomposition, dependency, and graph review passes', () => {
  const prompt = buildTechLeadPrompt({
    projectContext: { goal: 'Build a todo app' },
    schema: TECH_LEAD_PLAN_SCHEMA,
  });
  assert.match(prompt, /PASS 1 — DECOMPOSITION TREE/);
  assert.match(prompt, /PASS 2 — EXECUTION DEPENDENCIES/);
  assert.match(prompt, /PASS 3 — GRAPH REVIEW/);
  assert.match(prompt, /Never add parentId as a dependsOn entry/i);
  assert.match(prompt, /interface\/contract/i);
});


test('scheduler drains planning batches before dispatching delivery work', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P11' });
    store.createTask({ id: 'DELIVERY', projectId: 'P11', stage: 'developer' });

    store.enqueuePlanningRequest({
      id: 'REQ-1',
      projectId: 'P11',
      request: 'Add login support',
    });

    const provider = fakeProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({ gpu: 1 });
    const scheduler = new V2Scheduler({ store, roles: roles(), providers, resources });

    const first = await scheduler.tick('P11');
    assert.equal(store.getTask('DELIVERY').state, 'READY');
    assert.equal(first.started.length, 1);
    const firstPlanner = store.getTask(first.started[0]);
    assert.equal(firstPlanner.input.purpose, 'PLANNER_DECOMPOSE');
    assert.deepEqual(firstPlanner.input.requests.map(x => x.id), ['REQ-1']);
    assert.equal(store.getPlanningRequest('REQ-1').state, 'CLAIMED');

    // A new PM request arriving during planning stays pending for the next batch.
    store.enqueuePlanningRequest({
      id: 'REQ-2',
      projectId: 'P11',
      request: 'Also make todos user-scoped',
    });
    assert.deepEqual(
      store.listPlanningRequests('P11').map(x => [x.id, x.state]),
      [['REQ-1', 'CLAIMED'], ['REQ-2', 'PENDING']]
    );

    // Simulate completion of the first fixed planner DAG.
    const firstBatchId = store.getPlanningRequest('REQ-1').batchId;
    const firstFlowId = `planner:P11:${firstBatchId}`;
    for (const task of store.listTasks('P11', { flowId: firstFlowId })) {
      const current = store.getTask(task.id);
      store.updateTask(task.id, current.version, { state: 'DONE', execution: null });
    }

    const second = await scheduler.tick('P11');
    assert.equal(store.getPlanningRequest('REQ-1').state, 'PLANNED');
    assert.equal(store.getPlanningRequest('REQ-2').state, 'CLAIMED');
    assert.equal(store.getTask('DELIVERY').state, 'READY');
    assert.equal(second.started.length, 1);
    const secondPlanner = store.getTask(second.started[0]);
    assert.deepEqual(secondPlanner.input.requests.map(x => x.id), ['REQ-2']);

    // Once the queue is fully drained, delivery becomes eligible again.
    const secondBatchId = store.getPlanningRequest('REQ-2').batchId;
    const secondFlowId = `planner:P11:${secondBatchId}`;
    for (const task of store.listTasks('P11', { flowId: secondFlowId })) {
      const current = store.getTask(task.id);
      store.updateTask(task.id, current.version, { state: 'DONE', execution: null });
    }

    const third = await scheduler.tick('P11');
    assert.equal(store.getPlanningRequest('REQ-2').state, 'PLANNED');
    assert.deepEqual(third.started, ['DELIVERY']);
    assert.equal(store.getTask('DELIVERY').state, 'WORKING');

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planning batch atomically snapshots all currently pending requests in arrival order', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P12' });
    store.enqueuePlanningRequest({ id: 'R1', projectId: 'P12', request: 'first' });
    store.enqueuePlanningRequest({ id: 'R2', projectId: 'P12', request: 'second' });
    store.enqueuePlanningRequest({ id: 'R3', projectId: 'P12', request: 'third' });

    const pending = store.listPlanningRequests('P12', { states: ['PENDING'] });
    assert.deepEqual(pending.map(x => x.id), ['R1', 'R2', 'R3']);

    store.createPlanningBatch({
      projectId: 'P12',
      batchId: 'batch-test',
      requestIds: pending.map(x => x.id),
      tasks: [{
        id: 'planner:test:decompose',
        stage: 'tech_lead',
        input: {
          purpose: 'PLANNER_DECOMPOSE',
          planningBatchId: 'batch-test',
          requests: pending.map(x => ({ id: x.id, sequence: x.sequence })),
        },
      }],
    });

    assert.deepEqual(
      store.listPlanningRequests('P12').map(x => [x.id, x.state, x.batchId]),
      [
        ['R1', 'CLAIMED', 'batch-test'],
        ['R2', 'CLAIMED', 'batch-test'],
        ['R3', 'CLAIMED', 'batch-test'],
      ]
    );
    const plannerTask = store.getTask('planner:test:decompose');
    assert.deepEqual(plannerTask.input.requests.map(x => x.id), ['R1', 'R2', 'R3']);

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
