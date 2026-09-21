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
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import {
  ensurePlannerArtifactLayout,
  loadPlannerArtifactPlan,
  validatePlannerArtifactPlan,
} from '../src/v2/planner-artifacts.js';

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


test('supervisor waits for run termination then consumes sealed role-tool result instead of provider prose', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-role-tool' });
    store.createTask({
      id: 'T-role-tool',
      projectId: 'P-role-tool',
      stage: 'tester',
      state: 'WORKING',
      execution: {
        provider: 'fake',
        externalId: 'would-return-prose',
        attemptId: 'P-role-tool:T-role-tool:tester:1',
        resources: ['gpu'],
      },
      history: [{
        type: 'ROLE_RESULT',
        role: 'tester',
        outcome: 'PASS',
        summary: 'Fresh verification passed.',
        keyPoints: ['all acceptance checks passed'],
        artifacts: ['evidence.json'],
        result: { evidence: 'fresh' },
        attemptId: 'P-role-tool:T-role-tool:tester:1',
        source: 'role_result_tool',
      }],
    });

    let polls = 0;
    const provider = {
      id: 'fake',
      async start() { throw new Error('not used'); },
      async poll() {
        polls += 1;
        return { state: 'FAILED', failure: 'INVALID_ROLE_RESULT: prose' };
      },
      async cancel() {},
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({ gpu: 1 });
    resources.recover(store.listTasks('P-role-tool'));
    const supervisor = new V2Supervisor({ store, providers, resources });

    await supervisor.audit('P-role-tool');
    const task = store.getTask('T-role-tool');
    assert.equal(polls, 1);
    assert.equal(task.state, 'RESULT_READY');
    assert.equal(task.execution, null);
    assert.deepEqual(task.artifacts, ['evidence.json']);
    assert.deepEqual(resources.snapshot(), []);
    assert.equal(store.listIncidents('P-role-tool').length, 0);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('supervisor re-checks durable role-tool result committed during provider poll', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-role-tool-race' });
    store.createTask({
      id: 'T-role-tool-race',
      projectId: 'P-role-tool-race',
      stage: 'tester',
      state: 'WORKING',
      execution: {
        provider: 'fake',
        externalId: 'run-race',
        attemptId: 'P-role-tool-race:T-role-tool-race:tester:1',
        resources: [],
      },
    });

    const provider = {
      id: 'fake',
      async start() { throw new Error('not used'); },
      async poll() {
        const current = store.getTask('T-role-tool-race');
        store.appendTaskHistory('T-role-tool-race', current.version, {
          type: 'ROLE_RESULT',
          role: 'tester',
          outcome: 'PASS',
          summary: 'Submitted while poll was waiting.',
          keyPoints: [],
          artifacts: [],
          result: { evidence: 'fresh' },
          attemptId: 'P-role-tool-race:T-role-tool-race:tester:1',
          source: 'role_result_tool',
        });
        return { state: 'FAILED', failure: 'INVALID_ROLE_RESULT: trailing prose' };
      },
      async cancel() {},
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({});
    const supervisor = new V2Supervisor({ store, providers, resources });

    await supervisor.audit('P-role-tool-race');
    const task = store.getTask('T-role-tool-race');
    assert.equal(task.state, 'RESULT_READY');
    assert.equal(task.execution, null);
    assert.equal(store.listIncidents('P-role-tool-race').length, 0);
    assert.equal(
      task.history.filter(entry => entry?.type === 'SYSTEM_INTERRUPTION').length,
      0,
    );
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


test('logical parent-child hierarchy does not create execution dependencies', () => {
  const tasks = [
    { id: 'ROOT', scope: 'delivery', state: 'READY' },
    { id: 'FEATURE', scope: 'delivery', parentId: 'ROOT', state: 'READY' },
    { id: 'LEAF', scope: 'delivery', parentId: 'FEATURE', state: 'READY' },
  ];

  const graph = buildExecutionGraph(tasks);
  assert.deepEqual(graph.prerequisitesOf('ROOT'), []);
  assert.deepEqual(graph.prerequisitesOf('FEATURE'), []);
  assert.deepEqual(graph.prerequisitesOf('LEAF'), []);
  assert.equal(graph.isRunnable(tasks[0]), true);
  assert.equal(graph.isRunnable(tasks[1]), true);
  assert.equal(graph.isRunnable(tasks[2]), true);
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

test('Tech Lead v2 plan validator catches explicit execution cycles independently of logical hierarchy', () => {
  const plan = {
    version: 2,
    projectSummary: 'cycle',
    rootTaskId: 'ROOT',
    tasks: [
      { id: 'ROOT', title: 'Root', intent: 'root', parentId: null, dependsOn: [], acceptanceCriteria: ['root'], testStrategy: 'root' },
      { id: 'A', title: 'A', intent: 'a', parentId: 'ROOT', dependsOn: ['B'], acceptanceCriteria: ['a'], testStrategy: 'a' },
      { id: 'B', title: 'B', intent: 'b', parentId: 'ROOT', dependsOn: ['A'], acceptanceCriteria: ['b'], testStrategy: 'b' },
    ],
  };
  assert.throws(() => validateTechLeadPlan(plan), /execution graph contains a cycle/);
});

test('Tech Lead prompt explains Ariad model and all planning scenarios', () => {
  const prompt = buildTechLeadPrompt({
    projectContext: { goal: 'Build a todo app' },
    schema: TECH_LEAD_PLAN_SCHEMA,
  });
  assert.match(prompt, /ARIAD MODEL/);
  assert.match(prompt, /GREENFIELD/);
  assert.match(prompt, /EXISTING ARIAD PROJECT/);
  assert.match(prompt, /EXISTING NON-ARIAD PROJECT/);
  assert.match(prompt, /Logical tree/i);
  assert.match(prompt, /Milestones/i);
  assert.match(prompt, /TAKEOVER_NOTE/);
  assert.match(prompt, /fresh verification/i);
  assert.match(prompt, /stop for human review/i);
  assert.match(prompt, /children complete before parent integration work/i);
  assert.match(prompt, /another TL could pick this project up/i);
  assert.match(prompt, /project-wide, not milestone-local/i);
  assert.match(prompt, /complete currently-known route to project completion/i);
  assert.match(prompt, /should normally allow Ariad to continue into the next already-planned milestone/i);
  assert.match(prompt, /Do not create routine human gates between milestones/i);
  assert.match(prompt, /plan reaches the project root/i);
});

test('split planner artifacts use flat dotted ids and milestone hierarchy derives execution prerequisites', () => {
  const { dir } = tempDb();
  try {
    const artifactRoot = path.join(dir, 'artifacts');
    const { logicalDir, milestoneDir } = ensurePlannerArtifactLayout(artifactRoot);

    fs.writeFileSync(path.join(logicalDir, 'game.json'), JSON.stringify({
      id: 'game',
      title: 'Game',
      summary: 'Complete game',
      parentId: null,
    }));
    fs.writeFileSync(path.join(logicalDir, 'game.battle.json'), JSON.stringify({
      id: 'game.battle',
      title: 'Battle',
      summary: 'Battle capability',
      parentId: 'game',
    }));

    fs.writeFileSync(path.join(milestoneDir, 'M1.json'), JSON.stringify({
      id: 'M1',
      title: 'Integrated slice',
      goal: 'Integrate the child battle slice.',
      parentId: null,
      dependsOn: [],
      logicalRefs: ['game'],
      acceptanceCriteria: ['Whole slice works end to end.'],
      testStrategy: 'Run whole-slice E2E.',
      tasks: [{
        id: 'T-INTEGRATE',
        title: 'Integrate slice',
        intent: 'Verify the whole slice.',
        dependsOn: [],
        logicalRefs: ['game'],
        acceptanceCriteria: ['Integration passes.'],
        testStrategy: 'Run E2E.',
      }],
    }));
    fs.writeFileSync(path.join(milestoneDir, 'M1.1.json'), JSON.stringify({
      id: 'M1.1',
      title: 'Battle slice',
      goal: 'Deliver battle capability.',
      parentId: 'M1',
      dependsOn: [],
      logicalRefs: ['game.battle'],
      acceptanceCriteria: ['Battle works.'],
      testStrategy: 'Run battle tests.',
      tasks: [{
        id: 'T-BATTLE',
        title: 'Battle implementation',
        intent: 'Deliver battle.',
        dependsOn: [],
        logicalRefs: ['game.battle'],
        acceptanceCriteria: ['Battle is usable.'],
        testStrategy: 'Run battle test.',
      }],
    }));

    const raw = loadPlannerArtifactPlan(artifactRoot);
    const validated = validatePlannerArtifactPlan(raw).plan;
    assert.equal(validated.version, 3);
    assert.equal(validated.logicalRootId, 'game');
    assert.deepEqual(validated.tasks.find(task => task.id === 'T-BATTLE').dependsOn, []);
    assert.deepEqual(validated.tasks.find(task => task.id === 'T-INTEGRATE').dependsOn, ['T-BATTLE']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('final validator reloads raw v3 filesystem artifacts instead of revalidating compiled predecessor plan', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-v3-final', mode: 'TAKEOVER' });
    const artifactRoot = path.join(dir, 'artifacts');
    const { logicalDir, milestoneDir } = ensurePlannerArtifactLayout(artifactRoot);

    fs.writeFileSync(path.join(logicalDir, 'game.json'), JSON.stringify({
      id: 'game',
      title: 'Game',
      summary: 'Recovered game',
      parentId: null,
    }));
    fs.writeFileSync(path.join(milestoneDir, 'M0.json'), JSON.stringify({
      id: 'M0',
      title: 'Baseline',
      goal: 'Establish a runnable recovered baseline.',
      parentId: null,
      dependsOn: [],
      logicalRefs: ['game'],
      acceptanceCriteria: ['Baseline is runnable.'],
      testStrategy: 'Run baseline integration.',
      tasks: [{
        id: 'm0-baseline-integ',
        title: 'Baseline integration',
        intent: 'Assemble and run the recovered baseline.',
        dependsOn: [],
        logicalRefs: ['game'],
        acceptanceCriteria: ['Recovered baseline runs.'],
        testStrategy: 'Run the baseline E2E.',
      }],
    }));

    const compiled = validatePlannerArtifactPlan(loadPlannerArtifactPlan(artifactRoot)).plan;
    assert.equal(compiled.milestones[0].tasks, undefined);

    store.createControlFlow({
      projectId: 'P-v3-final',
      flowId: 'planner-flow',
      tasks: [
        {
          id: 'prior-validator',
          stage: 'plan_validator',
          state: 'DONE',
          history: [{
            type: 'ROLE_RESULT',
            role: 'plan_validator',
            outcome: 'PASS',
            result: { valid: true, plan: compiled, error: null },
          }],
        },
        {
          id: 'final-validator',
          stage: 'plan_validator',
          dependsOn: ['prior-validator'],
          input: { purpose: 'PLANNER_FINAL_VALIDATE' },
        },
      ],
    });

    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      artifactRoot,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
    });
    const task = store.getTask('final-validator');
    const prepared = definitions.plan_validator.prepare({ task });
    const result = await prepared.execute();
    assert.equal(result.outcome, 'PASS');
    assert.equal(result.result.valid, true);
    assert.equal(result.result.plan.tasks[0].id, 'm0-baseline-integ');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bad legacy planner artifact is isolated and recorded once instead of crashing plan lookup', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-bad-artifact' });
    const artifactRoot = path.join(dir, 'artifacts');
    fs.mkdirSync(path.join(artifactRoot, 'planner'), { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'planner', 'broken.json'), '{"version":2,"tasks":[');

    store.createControlFlow({
      projectId: 'P-bad-artifact',
      flowId: 'planner-flow',
      tasks: [
        {
          id: 'legacy-plan',
          stage: 'tech_lead',
          state: 'DONE',
          history: [{
            type: 'ROLE_RESULT',
            role: 'tech_lead',
            outcome: 'PLANNED',
            result: { artifactRef: 'planner/broken.json' },
          }],
        },
        {
          id: 'validate-bad',
          stage: 'plan_validator',
          dependsOn: ['legacy-plan'],
          input: { purpose: 'PLANNER_FINAL_VALIDATE' },
        },
      ],
    });

    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      artifactRoot,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
    });
    const task = store.getTask('validate-bad');
    const first = await definitions.plan_validator.prepare({ task }).execute();
    const second = await definitions.plan_validator.prepare({ task }).execute();
    assert.equal(first.outcome, 'NOT_PASS');
    assert.equal(first.result.error, 'NO_CANDIDATE_PLAN');
    assert.equal(second.outcome, 'NOT_PASS');
    const incidents = store.listIncidents('P-bad-artifact');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].type, 'PLANNER_ARTIFACT_INVALID');
    assert.equal(incidents[0].artifactRef, 'planner/broken.json');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('split planner artifact registry rejects subdirectories and filename/id drift', () => {
  const { dir } = tempDb();
  try {
    const artifactRoot = path.join(dir, 'artifacts');
    const { logicalDir } = ensurePlannerArtifactLayout(artifactRoot);
    fs.mkdirSync(path.join(logicalDir, 'nested'));
    assert.throws(() => loadPlannerArtifactPlan(artifactRoot), /subdirectories are not allowed/);
    fs.rmSync(path.join(logicalDir, 'nested'), { recursive: true, force: true });
    fs.writeFileSync(path.join(logicalDir, 'wrong.json'), JSON.stringify({
      id: 'game',
      title: 'Game',
      summary: 'Game',
      parentId: null,
    }));
    assert.throws(() => loadPlannerArtifactPlan(artifactRoot), /must equal filename id wrong/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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


test('applyDeliveryPlan atomically preserves completed work and obsoletes removed tasks', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P13' });
    store.createTask({ id: 'KEEP', projectId: 'P13', state: 'DONE', stage: 'reviewer', history: [{ type: 'ROLE_RESULT', role: 'reviewer', outcome: 'PASS' }] });
    store.createTask({ id: 'REMOVE', projectId: 'P13', state: 'READY', stage: 'developer' });

    store.applyDeliveryPlan('P13', {
      version: 2,
      projectSummary: 'updated',
      rootTaskId: 'ROOT',
      tasks: [
        { id: 'ROOT', title: 'Root', intent: 'integrate', parentId: null, dependsOn: [], acceptanceCriteria: ['done'], testStrategy: 'e2e' },
        { id: 'KEEP', title: 'Keep', intent: 'preserve completed work', parentId: 'ROOT', dependsOn: [], acceptanceCriteria: ['kept'], testStrategy: 'existing tests' },
      ],
    });

    assert.equal(store.getTask('KEEP').state, 'DONE');
    assert.equal(store.getTask('KEEP').history.length, 1);
    assert.equal(store.getTask('REMOVE').state, 'OBSOLETE');
    assert.equal(store.getTask('ROOT').state, 'READY');
    assert.equal(store.getProject('P13').deliveryPlanVersion, 1);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler runs afterPersist only after the transition is durable', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-after' });
    store.createTask({
      id: 'T-after',
      projectId: 'P-after',
      stage: 'reviewer',
      state: 'RESULT_READY',
      history: [{ type: 'ROLE_RESULT', role: 'reviewer', outcome: 'PASS', result: {} }],
    });

    let observed = null;
    const roleRegistry = new RoleRegistry();
    roleRegistry.register('reviewer', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => ({ state: 'DONE' }),
      afterPersist: ({ task }) => {
        observed = {
          argumentState: task.state,
          durableState: store.getTask(task.id).state,
          execution: store.getTask(task.id).execution,
        };
        return null;
      },
    });
    const providers = new ProviderRegistry();
    providers.register(fakeProvider());
    const scheduler = new V2Scheduler({
      store,
      roles: roleRegistry,
      providers,
      resources: new ResourcePool({}),
    });

    await scheduler.tick('P-after');
    assert.deepEqual(observed, {
      argumentState: 'DONE',
      durableState: 'DONE',
      execution: null,
    });
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler persists a stable attempt identity before provider start', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P14' });
    store.createTask({ id: 'T14', projectId: 'P14', stage: 'developer' });

    let seen = null;
    const provider = {
      id: 'capture',
      async start(spec) {
        seen = spec;
        const durable = store.getTask('T14');
        assert.equal(durable.state, 'WORKING');
        assert.equal(durable.execution.attemptId, spec.attemptId);
        assert.equal(durable.execution.idempotencyKey, spec.idempotencyKey);
        return { externalId: 'capture-1' };
      },
      async poll() { return { state: 'RUNNING' }; },
      async cancel() {},
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const roleRegistry = new RoleRegistry();
    roleRegistry.register('developer', {
      prepare: () => ({ provider: 'capture' }),
      transition: () => ({ stage: 'tester', state: 'READY' }),
    });
    const scheduler = new V2Scheduler({
      store,
      roles: roleRegistry,
      providers,
      resources: new ResourcePool({}),
    });

    await scheduler.tick('P14');
    assert.equal(seen.attemptId, 'P14:T14:developer:1');
    assert.equal(seen.idempotencyKey, 'ariad:v2:P14:T14:developer:1');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('takeover task history survives validation and is persisted without duplicate notes', () => {
  const { dir, file } = tempDb();
  try {
    const plan = {
      version: 2,
      projectSummary: 'Recovered project',
      rootTaskId: 'ROOT',
      tasks: [{
        id: 'ROOT',
        title: 'Recovered project',
        intent: 'Preserve and finish the existing project.',
        parentId: null,
        dependsOn: [],
        acceptanceCriteria: ['Current project behavior is freshly verified.'],
        testStrategy: 'Run the current project acceptance suite.',
        history: [{
          type: 'TAKEOVER_NOTE',
          summary: 'Existing implementation is present; inspect and reuse it before replacing code.',
          existingCode: ['src/existing.js'],
        }],
      }],
    };
    const validated = validateTechLeadPlan(plan).plan;
    assert.equal(validated.tasks[0].history[0].type, 'TAKEOVER_NOTE');

    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-take-history' });
    store.applyDeliveryPlan('P-take-history', validated);
    assert.equal(store.getTask('ROOT').history.length, 1);

    store.applyDeliveryPlan('P-take-history', validated);
    assert.equal(store.getTask('ROOT').history.length, 1);

    const revised = structuredClone(validated);
    revised.tasks[0].history.push({
      type: 'TAKEOVER_NOTE',
      summary: 'Existing tests were found and should be freshly rerun.',
    });
    store.applyDeliveryPlan('P-take-history', revised);
    assert.equal(store.getTask('ROOT').history.length, 2);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default delivery roles are reuse-first but require fresh verification evidence', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-reuse' });
    store.createTask({
      id: 'T-reuse',
      projectId: 'P-reuse',
      history: [{
        type: 'TAKEOVER_NOTE',
        summary: 'Existing code and tests are available.',
      }],
    });
    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
    });
    const task = store.getTask('T-reuse');
    assert.match(definitions.developer.prepare({ task }).context.v2Prompt, /reuse\/fix\/extend/i);
    assert.match(definitions.tester.prepare({ task }).context.v2Prompt, /freshly executed/i);
    assert.match(definitions.reviewer.prepare({ task }).context.v2Prompt, /fresh evidence/i);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('accepted takeover plan pauses at human review until a human decision is recorded', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-take-gate', pmBinding: 'pm:P-take-gate', mode: 'TAKEOVER', sourcePath: '/tmp/existing-repo' });
    store.enqueuePlanningRequest({
      id: 'restore-1',
      projectId: 'P-take-gate',
      request: { purpose: 'INITIAL_PLAN' },
    });
    const plan = validateTechLeadPlan({
      version: 2,
      projectSummary: 'Recovered',
      rootTaskId: 'ROOT',
      tasks: [{
        id: 'ROOT',
        title: 'Recovered root',
        intent: 'Finish the recovered project.',
        parentId: null,
        dependsOn: [],
        acceptanceCriteria: ['Recovered project is freshly verified.'],
        testStrategy: 'Run current acceptance checks.',
        history: [{ type: 'TAKEOVER_NOTE', summary: 'Reuse existing implementation.' }],
      }],
    }).plan;
    store.createPlanningBatch({
      projectId: 'P-take-gate',
      batchId: 'batch-take',
      requestIds: ['restore-1'],
      tasks: [
        {
          id: 'TL-take',
          stage: 'tech_lead',
          state: 'DONE',
          history: [{
            type: 'ROLE_RESULT',
            role: 'tech_lead',
            outcome: 'PLANNED',
            result: { plan },
          }],
        },
        {
          id: 'PM-take',
          stage: 'pm',
          dependsOn: ['TL-take'],
          input: { planningBatchId: 'batch-take', purpose: 'PLANNER_PM_REVIEW' },
        },
      ],
    });

    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
    });
    let pmTask = store.getTask('PM-take');
    const first = definitions.pm.transition({
      task: pmTask,
      result: { outcome: 'PLAN_ACCEPTED', result: { reason: 'Reconstruction is coherent.' } },
    });
    assert.equal(first.state, 'NEEDS_HUMAN');
    assert.equal(first.transitionHistory.type, 'TAKEOVER_REVIEW');
    assert.equal(store.getTask('ROOT').history[0].type, 'TAKEOVER_NOTE');

    pmTask = store.appendTaskHistory('PM-take', pmTask.version, {
      type: 'HUMAN_DECISION',
      decision: 'accept',
    });
    const second = definitions.pm.transition({
      task: pmTask,
      result: { outcome: 'PLAN_ACCEPTED', result: { reason: 'Human accepted reconstruction.' } },
    });
    assert.equal(second.state, 'DONE');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('milestone metadata assigns tasks without creating special execution nodes', () => {
  const validated = validateTechLeadPlan({
    version: 2,
    projectSummary: 'Milestone project',
    rootTaskId: 'ROOT',
    tasks: [
      {
        id: 'ROOT',
        title: 'Project complete',
        intent: 'Complete the whole product.',
        parentId: null,
        dependsOn: [],
        acceptanceCriteria: ['Whole product works.'],
        testStrategy: 'Run project acceptance.',
      },
      {
        id: 'FEATURE_A',
        title: 'Feature A',
        intent: 'Provide feature A.',
        parentId: 'ROOT',
        dependsOn: [],
        acceptanceCriteria: ['Feature A works.'],
        testStrategy: 'Run feature A tests.',
      },
      {
        id: 'FEATURE_B',
        title: 'Feature B',
        intent: 'Integrate feature B with A.',
        parentId: 'ROOT',
        dependsOn: ['FEATURE_A'],
        milestoneId: 'M2',
        acceptanceCriteria: ['Feature B works.'],
        testStrategy: 'Run feature B integration tests.',
      },
      {
        id: 'INTEGRATE_AB',
        title: 'Integrate A and B',
        intent: 'Reconcile A/B state and wiring for the second milestone.',
        parentId: 'ROOT',
        dependsOn: ['FEATURE_A', 'FEATURE_B'],
        milestoneId: 'M2',
        acceptanceCriteria: ['A and B work together.'],
        testStrategy: 'Run integration smoke tests.',
      },
    ],
    milestones: [
      {
        id: 'M1',
        title: 'First usable slice',
        goal: 'Feature A is usable.',
        parentId: null,
        dependsOn: [],
        logicalTaskIds: ['FEATURE_A'],
        acceptanceCriteria: ['Feature A is usable.'],
        testStrategy: 'Run feature A acceptance.',
      },
      {
        id: 'M2',
        title: 'Second integrated slice',
        goal: 'Feature B is integrated with A.',
        parentId: null,
        dependsOn: ['M1'],
        logicalTaskIds: ['FEATURE_B', 'INTEGRATE_AB'],
        acceptanceCriteria: ['A and B form a usable integrated slice.'],
        testStrategy: 'Run A/B milestone acceptance.',
      },
    ],
  }).plan;

  const byId = new Map(validated.tasks.map(task => [task.id, task]));
  assert.equal(byId.get('FEATURE_A').milestoneId, 'M1');
  assert.equal(byId.get('FEATURE_B').milestoneId, 'M2');
  assert.equal(byId.get('INTEGRATE_AB').milestoneId, 'M2');
  assert.equal(validated.tasks.length, 4);
  assert.deepEqual(validated.milestones.map(item => item.id), ['M1', 'M2']);
});

test('milestone validator rejects an earlier milestone depending on future milestone work', () => {
  const plan = {
    version: 2,
    projectSummary: 'Bad milestone direction',
    rootTaskId: 'ROOT',
    tasks: [
      {
        id: 'ROOT',
        title: 'Root',
        intent: 'Complete project.',
        parentId: null,
        dependsOn: [],
        acceptanceCriteria: ['done'],
        testStrategy: 'e2e',
      },
      {
        id: 'A',
        title: 'A',
        intent: 'A',
        parentId: 'ROOT',
        dependsOn: ['B'],
        milestoneId: 'M1',
        acceptanceCriteria: ['a'],
        testStrategy: 'a',
      },
      {
        id: 'B',
        title: 'B',
        intent: 'B',
        parentId: 'ROOT',
        dependsOn: [],
        milestoneId: 'M2',
        acceptanceCriteria: ['b'],
        testStrategy: 'b',
      },
    ],
    milestones: [
      {
        id: 'M1',
        title: 'M1',
        goal: 'first',
        parentId: null,
        dependsOn: [],
        logicalTaskIds: ['A'],
        acceptanceCriteria: ['m1'],
        testStrategy: 'm1',
      },
      {
        id: 'M2',
        title: 'M2',
        goal: 'second',
        parentId: null,
        dependsOn: ['M1'],
        logicalTaskIds: ['B'],
        acceptanceCriteria: ['m2'],
        testStrategy: 'm2',
      },
    ],
  };

  assert.throws(
    () => validateTechLeadPlan(plan),
    /cross-milestone dependency.*not allowed/i
  );
});

test('applyDeliveryPlan persists milestone metadata and ordinary task milestoneId', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-milestone' });
    const validated = validateTechLeadPlan({
      version: 2,
      projectSummary: 'Milestone apply',
      rootTaskId: 'ROOT',
      tasks: [
        {
          id: 'ROOT',
          title: 'Root',
          intent: 'Complete project.',
          parentId: null,
          dependsOn: [],
          acceptanceCriteria: ['done'],
          testStrategy: 'e2e',
        },
        {
          id: 'FEATURE',
          title: 'Feature',
          intent: 'Feature.',
          parentId: 'ROOT',
          dependsOn: [],
          acceptanceCriteria: ['feature'],
          testStrategy: 'feature',
        },
      ],
      milestones: [{
        id: 'M1',
        title: 'M1',
        goal: 'usable feature',
        parentId: null,
        dependsOn: [],
        logicalTaskIds: ['FEATURE'],
        acceptanceCriteria: ['usable'],
        testStrategy: 'smoke',
      }],
    }).plan;

    store.applyDeliveryPlan('P-milestone', validated);
    const feature = store.getTask('FEATURE');
    assert.equal(feature.milestoneId, 'M1');
    assert.equal(feature.stage, 'developer');
    assert.equal(store.listTasks('P-milestone', { scope: 'delivery' }).length, 2);
    assert.equal(store.getProject('P-milestone').milestones[0].id, 'M1');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
