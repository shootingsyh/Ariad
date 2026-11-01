import { scopeOfTask } from '../src/v2/control-task-policy.js';
import {legacyApplyDeliveryPlan} from './legacy-delivery-plan-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool, ScopedResourcePool } from '../src/v2/resource-pool.js';
import { V2Scheduler, partitionGraphs } from '../src/v2/scheduler.js';
import { buildExecutionGraph } from '../src/v2/execution-graph.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import { buildTechLeadPrompt } from '../src/v2/tech-lead-prompt.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { aggregateTesterSubmission } from '../src/v2/acceptance.js';
import { validatePlanAutonomy } from '../src/v2/autonomy.js';
import { ensureTakeoverReviewState, recoverObsoleteTakeoverHumanGates } from '../src/v2/takeover-gate.js';
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
  registry.register('test_engineer', {prepare: ({task}) => ({provider:'fake',prompt:'plan tests',resources:['gpu']}),transition:()=>({stage:'tester',state:'READY'})});
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
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T1', projectId: 'P1', stage: 'developer' });

    const roleRegistry = roles();
    const provider = fakeProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({ gpu: 1 });
    const scheduler = new V2Scheduler({ store, roles: roleRegistry, providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });

    await scheduler.tick('P1');
    let task = store.getTask('T1');
    assert.equal(scopeOfTask(task), 'delivery');
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
    assert.equal(task.stage, 'test_engineer');
    assert.equal(task.state, 'WORKING');

    provider.complete(task.execution.externalId, {result:{testPlan:{testCases:[{entry:'fixture',command:'node --test',covers:[],executionScope:[]}]}}});
    await supervisor.audit('P1');
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
    assert.equal(task.history.filter(x => x.type === 'ROLE_RESULT').length, 4);
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
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'A', projectId: 'P2', stage: 'developer' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'B', projectId: 'P2', stage: 'developer' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'C', projectId: 'P2', stage: 'developer', dependsOn: ['A', 'B'] });

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
    assert.equal(a.stage, 'test_engineer');
    assert.equal(a.state, 'WORKING');
    assert.equal(store.getTask('B').state, 'READY');
    assert.equal(store.getTask('C').state, 'READY');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});



test('planning autonomy validator rejects required external human labor unless user explicitly requested it', () => {
  const plan = {
    tasks: [{
      id: 'ROOT',
      title: 'Complete game',
      intent: 'Ship the game.',
      parentId: null,
      dependsOn: [],
      acceptanceCriteria: ['10 external human players must play CH1 and 8/10 must pass.'],
      testStrategy: 'Recruit external human players and collect manual results.',
    }],
  };

  assert.throws(
    () => validatePlanAutonomy(plan, [{ request: { purpose: 'INITIAL_PLAN', instruction: 'Build and verify the game autonomously.' } }]),
    error => error?.code === 'INVALID_AUTONOMY_REQUIREMENT',
  );

  assert.doesNotThrow(() => validatePlanAutonomy(plan, [{
    request: {
      purpose: 'INITIAL_PLAN',
      instruction: 'Run a human playtest study with external testers before release.',
    },
  }]));
});

test('runtime acceptance cannot be satisfied by static or proxy evidence', () => {
  const task = {
    acceptanceCriteria: ['Windows build starts and reaches the title screen.'],
    verification: [{ criterionId: 'AC1', mode: 'runtime', target: 'windows.host-via-wsl' }],
  };

  const staticOnly = aggregateTesterSubmission(task, {
    outcome: 'PASS',
    summary: 'PE exists',
    result: {
      criteria: [{
        criterionId: 'AC1',
        status: 'SATISFIED',
        evidenceType: 'static',
        evidence: ['game.exe exists', 'PE header valid'],
        reason: 'export succeeded',
      }],
    },
  });
  assert.equal(staticOnly.outcome, 'NOT_PASS');
  assert.equal(staticOnly.result.criteria[0].status, 'UNVERIFIED');
  assert.match(staticOnly.result.criteria[0].reason, /Runtime verification required/i);

  const proxyOnly = aggregateTesterSubmission(task, {
    outcome: 'PASS',
    summary: 'proxy says likely okay',
    result: {
      criteria: [{
        criterionId: 'AC1',
        status: 'SATISFIED',
        evidenceType: 'proxy',
        evidence: ['Linux build ran'],
        reason: 'same source tree',
      }],
    },
  });
  assert.equal(proxyOnly.outcome, 'NOT_PASS');
  assert.equal(proxyOnly.result.aggregate.unverified, 1);

  const executed = aggregateTesterSubmission(task, {
    outcome: 'PASS',
    summary: 'Windows build executed',
    result: {
      criteria: [{
        criterionId: 'AC1',
        status: 'SATISFIED',
        evidenceType: 'runtime',
        evidence: ['windows-smoke.log'],
        reason: 'process launched and title screen probe passed',
      }],
    },
  });
  assert.equal(executed.outcome, 'PASS');
  assert.equal(executed.result.criteria[0].status, 'SATISFIED');
});

test('verification metadata survives DB draft authoring', () => {
  const { dir, file } = tempDb();
  try {
    const vs = new VersionedStore(file);
    vs.initProject('verify-proj');
    vs.createDraft({ createdBy: 'tl' });
    vs.applyTreeOps([
      { op: 'upsertTask', task: { id: 'ROOT', taskKind: 'MILESTONE_TASK', title: 'Runtime root', intent: 'Verify runtime behavior.', dependsOn: [], acceptanceCriteria: ['Windows runtime starts.'], testStrategy: 'Launch Windows build through WSL host interop.', verification: [{ criterionId: 'AC1', mode: 'runtime', target: 'windows.host-via-wsl' }] } },
    ]);
    const spec = vs.listSpecTasks(vs.getOpenDraft().version).find(task => task.id === 'ROOT');
    assert.deepEqual(spec.verification, [
      { criterionId: 'AC1', mode: 'runtime', target: 'windows.host-via-wsl' },
    ]);
    vs.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('tester aggregate verdict is computed from required criterion statuses', () => {
  const task = {
    acceptanceCriteria: ['Windows runtime smoke passes', 'Full playthrough clears every required map'],
  };
  const result = aggregateTesterSubmission(task, {
    outcome: 'PASS',
    summary: 'model claimed pass',
    result: {
      criteria: [
        { criterionId: 'AC1', status: 'SATISFIED', evidence: ['windows-run.log'], reason: 'executed' },
        { criterionId: 'AC2', status: 'FAILED', evidence: ['playthrough.json'], reason: 'one defeat' },
      ],
    },
  });
  assert.equal(result.outcome, 'NOT_PASS');
  assert.equal(result.result.aggregate.submittedOutcome, 'PASS');
  assert.equal(result.result.aggregate.failed, 1);

  const unverified = aggregateTesterSubmission(task, {
    outcome: 'PASS',
    summary: 'proxy evidence only',
    result: {
      criteria: [
        { criterionId: 'AC1', status: 'UNVERIFIED', evidence: ['binary exists'], reason: 'not executed' },
        { criterionId: 'AC2', status: 'SATISFIED', evidence: ['playthrough.json'], reason: 'cleared' },
      ],
    },
  });
  assert.equal(unverified.outcome, 'NOT_PASS');
  assert.equal(unverified.result.aggregate.unverified, 1);
});

test('supervisor adopts no terminal-JSON fallback: results come only from the result tool', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-compat' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'T-compat',
      projectId: 'P-compat',
      stage: 'tech_lead',
      state: 'WORKING',
      execution: {
        provider: 'fake',
        externalId: 'codex-compat',
        attemptId: 'P-compat:T-compat:tech_lead:1',
        completionProtocol: 'role_result_tool',
        protocolVersion: 'role-result-v2',
        projectVersion: 2,
        resources: [],
      },
    });
    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      async start() { throw new Error('not used'); },
      async poll() {
        return {
          state: 'COMPLETED',
          roleResultFallback: {
            source: 'terminal_json_result_tool_unavailable',
            attemptId: 'P-compat:T-compat:tech_lead:1',
            role: 'tech_lead',
            outcome: 'PLANNED',
            summary: 'planner finished',
            keyPoints: [],
            artifacts: [],
            result: null,
            runtime: { harness: 'codex', provider: 'openai', model: 'gpt-5.6-terra' },
            raw: { resultTool: 'unavailable' },
          },
        };
      },
      async cancel() {},
    });
    const resources = new ResourcePool({});
    const supervisor = new V2Supervisor({ store, providers, resources });
    await supervisor.audit('P-compat');
    const task = store.getTask('T-compat');
    // The terminal-JSON salvage is deleted: a provider-reported fallback is
    // not a result. The attempt ends as a missing-result interruption,
    // exactly like a plain completion with no result-tool call.
    assert.equal(task.state, 'READY');
    assert.equal(task.execution, null);
    assert.equal(task.history.some(entry => entry?.type === 'ROLE_RESULT'), false);
    assert.equal(task.history.some(entry => entry?.source === 'terminal_json_compatibility'), false);
    assert.equal(task.history.at(-1)?.failure, 'MISSING_ROLE_RESULT_TOOL');
    assert.equal(store.listIncidents('P-compat').at(-1)?.failure, 'MISSING_ROLE_RESULT_TOOL');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('role-result-tool attempts cannot succeed from provider terminal completion alone', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-tool-only' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'T-tool-only',
      projectId: 'P-tool-only',
      stage: 'tester',
      state: 'WORKING',
      execution: {
        provider: 'fake',
        externalId: 'terminal-pass',
        attemptId: 'P-tool-only:T-tool-only:tester:1',
        completionProtocol: 'role_result_tool',
        protocolVersion: 'role-result-v2',
        resources: [],
      },
    });

    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      async start() { throw new Error('not used'); },
      async poll() {
        return { state: 'COMPLETED', outcome: 'PASS', summary: 'terminal text claimed success' };
      },
      async cancel() {},
    });
    const resources = new ResourcePool({});
    const supervisor = new V2Supervisor({ store, providers, resources });

    await supervisor.audit('P-tool-only');
    const task = store.getTask('T-tool-only');
    assert.equal(task.state, 'READY');
    assert.equal(task.execution, null);
    assert.equal(task.history.some(entry => entry?.type === 'ROLE_RESULT'), false);
    assert.equal(task.history.at(-1)?.failure, 'MISSING_ROLE_RESULT_TOOL');
    assert.equal(store.listIncidents('P-tool-only').at(-1)?.failure, 'MISSING_ROLE_RESULT_TOOL');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manual system recovery resets the consecutive system-failure window', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-recovery-window' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'T-recovery-window',
      projectId: 'P-recovery-window',
      stage: 'tester',
      state: 'WORKING',
      execution: {
        provider: 'fake',
        externalId: 'terminal-pass',
        attemptId: 'P-recovery-window:T-recovery-window:tester:3',
        completionProtocol: 'role_result_tool',
        protocolVersion: 'role-result-v2',
        resources: [],
      },
      history: [
        { type: 'SYSTEM_INTERRUPTION', role: 'tester', failure: 'OLD_FAILURE_1' },
        { type: 'SYSTEM_INTERRUPTION', role: 'tester', failure: 'OLD_FAILURE_2' },
        { type: 'SYSTEM_RECOVERY', role: 'tester', reason: 'MANUAL_RESUME_AFTER_FAILED_PROJECT' },
      ],
    });

    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      async start() { throw new Error('not used'); },
      async poll() { return { state: 'COMPLETED' }; },
      async cancel() {},
    });
    const resources = new ResourcePool({});
    const supervisor = new V2Supervisor({ store, providers, resources });

    await supervisor.audit('P-recovery-window');
    const task = store.getTask('T-recovery-window');
    assert.equal(task.state, 'READY');
    assert.equal(task.history.at(-1)?.failure, 'MISSING_ROLE_RESULT_TOOL');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('supervisor recovers an orphaned WORKING task that already has a sealed role-tool result', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-role-tool' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
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
    store.createTask({ taskKind: 'MILESTONE_TASK',
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
    let task = store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T3', projectId: 'P3', stage: 'developer' });
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
    first.createTask({ taskKind: 'MILESTONE_TASK',
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

test('default runtime keeps only PM Tech Lead and Project Debugger persistent', () => {
  const registry = createDefaultV2Roles({
    store: {
      listTasks: () => [],
      listPlanningRequests: () => [],
      listIncidents: () => [],
      getProject: () => ({ id: 'P-policy' }),
    },
    workspace: process.cwd(),
  });
  assert.equal(registry.pm.sessionPolicy, 'persistent');
  assert.equal(registry.tech_lead.sessionPolicy, 'persistent');
  assert.equal(registry.project_debugger.sessionPolicy, 'persistent');
  assert.equal(registry.developer.sessionPolicy, undefined);
  assert.equal(registry.tester.sessionPolicy, undefined);
  assert.equal(registry.reviewer.sessionPolicy, undefined);
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
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'D1', projectId: 'P6', stage: 'developer' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'D2', projectId: 'P6', stage: 'developer', dependsOn: ['D1'] });
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

    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'BACKEND', projectId: 'P10', stage: 'developer' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'INTERFACE', projectId: 'P10', stage: 'developer', parentId: 'BACKEND' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'CONNECTION', projectId: 'P10', stage: 'developer', parentId: 'BACKEND', dependsOn: ['INTERFACE'] });

    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'UI', projectId: 'P10', stage: 'developer' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'DRAWING', projectId: 'P10', stage: 'developer', parentId: 'UI' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'LIST-BACKEND', projectId: 'P10', stage: 'developer', parentId: 'UI', dependsOn: ['INTERFACE'] });

    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'INIT', projectId: 'P10', stage: 'developer', dependsOn: ['INTERFACE'] });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'LOGIN', projectId: 'P10', stage: 'developer', dependsOn: ['INTERFACE'] });

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

test('scheduler drains planning batches before dispatching delivery work', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P11' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'DELIVERY', projectId: 'P11', stage: 'developer' });

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
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'KEEP', projectId: 'P13', state: 'DONE', stage: 'reviewer', history: [{ type: 'ROLE_RESULT', role: 'reviewer', outcome: 'PASS' }] });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'REMOVE', projectId: 'P13', state: 'READY', stage: 'developer' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'OLD-DONE', projectId: 'P13', state: 'DONE', stage: 'reviewer', history: [{ type: 'ROLE_RESULT', role: 'reviewer', outcome: 'PASS' }] });

    legacyApplyDeliveryPlan(store,'P13', {
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
    assert.equal(store.getTask('OLD-DONE').state, 'DONE', 'completed work remains immutable history even when absent from the new plan');
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
    store.createTask({ taskKind: 'MILESTONE_TASK',
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
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T14', projectId: 'P14', stage: 'developer' });

    let seen = null;
    const provider = {
      id: 'capture',
      async start(spec) {
        seen = spec;
        const durable = store.getTask('T14');
        assert.equal(durable.state, 'WORKING');
        assert.equal(durable.execution.attemptId, spec.attemptId);
        assert.equal(durable.execution.idempotencyKey, spec.idempotencyKey);
        assert.deepEqual(durable.execution.provenance, {
          pluginVersion: '0.6.test',
          openclawVersion: '2026.test',
          ariadCommit: 'abc123',
          controllerInstanceId: 'controller-test',
          runtime: 'openclaw-v2',
          modelRef: 'fake/model',
        });
        return { externalId: 'capture-1' };
      },
      async poll() { return { state: 'RUNNING' }; },
      async cancel() {},
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const roleRegistry = new RoleRegistry();
    roleRegistry.register('developer', {
      prepare: () => ({
        provider: 'capture',
        executionProvenance: {
          pluginVersion: '0.6.test',
          openclawVersion: '2026.test',
          ariadCommit: 'abc123',
          controllerInstanceId: 'controller-test',
          runtime: 'openclaw-v2',
          modelRef: 'fake/model',
        },
      }),
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

test('default delivery roles are reuse-first but require fresh verification evidence', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-reuse' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
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
    assert.match(definitions.developer.prepare({ task }).context.roleProtocol, /reuse\/fix\/extend/i);
    assert.throws(() => definitions.tester.prepare({ task }), /TEST_PLAN_MISSING/);
    const approved = store.appendTaskHistory(task.id, task.version, {type:'ROLE_RESULT',role:'test_engineer',outcome:'PASS',result:{testPlan:{testCases:[{entry:'fixture',command:'node --test',covers:[],executionScope:[]}]}}});
    assert.match(definitions.tester.prepare({ task: approved }).context.roleProtocol, /fresh execution evidence/i);
    assert.match(definitions.reviewer.prepare({ task }).context.roleProtocol, /fresh evidence/i);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delivery scheduler remains gated until PM explicitly enables delivery', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-delivery-gate', deliveryEnabled: false });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'D1', projectId: 'P-delivery-gate', stage: 'developer', state: 'READY' });

    const started = [];
    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      async start(input) {
        started.push(input.taskId);
        return { id: `run:${input.taskId}` };
      },
      async poll() { return { state: 'RUNNING' }; },
      async cancel() { return { cancelled: true }; },
    });
    const roleRegistry = new RoleRegistry();
    roleRegistry.register('developer', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => ({ state: 'DONE' }),
    });
    const scheduler = new V2Scheduler({
      store,
      roles: roleRegistry,
      providers,
      resources: new ResourcePool({}),
    });

    const blocked = await scheduler.tick('P-delivery-gate');
    assert.deepEqual(blocked.started, []);
    assert.equal(store.getTask('D1').state, 'READY');

    let project = store.getProject('P-delivery-gate');
    store.updateProject(project.id, project.version, { deliveryEnabled: true });
    const opened = await scheduler.tick('P-delivery-gate');
    assert.deepEqual(opened.started, ['D1']);
    assert.deepEqual(started, ['D1']);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('accepted takeover plan pauses at human review until a human decision is recorded', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-take-gate', pmBinding: 'pm:P-take-gate', mode: 'TAKEOVER', sourcePath: '/tmp/existing-repo', workspace: dir, versionedTree: true });
    const vs = new VersionedStore(file);
    vs.initProject('P-take-gate');
    vs.createDraft({ createdBy: 'tl' });
    const draft = vs.getOpenDraft();
    vs.applyTreeOps([{ op: 'upsertTask', task: { id: 'ROOT', taskKind: 'MILESTONE_TASK', title: 'Recovered root', intent: 'Finish the recovered project.', acceptanceCriteria: ['Recovered project is freshly verified.'], testStrategy: 'Run current acceptance checks.' } }]);
    vs.close();
    store.enqueuePlanningRequest({
      id: 'restore-1',
      projectId: 'P-take-gate',
      request: { purpose: 'INITIAL_PLAN' },
    });
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
            result: { plan: { source: 'db-draft', version: draft.version } },
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
      result: { outcome: 'PLAN_ACCEPTED', result: { reason: 'Reconstruction is coherent.', startDelivery: true } },
    });
    assert.equal(first.state, 'NEEDS_HUMAN');
    assert.equal(first.transitionHistory.role, 'pm');
    assert.equal(first.transitionHistory.type, 'PM_HUMAN_DECISION');
    assert.notEqual(store.getProject('P-take-gate').deliveryEnabled, true, 'takeover human gate must override PM start request');
    const stillDraft = new VersionedStore(file);
    assert.equal(stillDraft.getOpenDraft()?.version, draft.version, 'takeover review must not promote the draft before the human decides');
    stillDraft.close();

    pmTask = store.appendTaskHistory('PM-take', pmTask.version, {
      type: 'HUMAN_DECISION',
      decision: 'accept',
    });
    const second = definitions.pm.transition({
      task: pmTask,
      result: { outcome: 'PLAN_ACCEPTED', result: { reason: 'Human accepted reconstruction.', startDelivery: true } },
    });
    assert.equal(second.state, 'DONE');
    assert.equal(second.transitionHistory.type, 'VERSIONED_TREE_PLAN_ACCEPTED');
    assert.equal(store.getProject('P-take-gate').deliveryEnabled, true);
    assert.equal(store.getProject('P-take-gate').takeoverReviewRequired, false);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('later technical replans in an approved TAKEOVER project do not create another human gate', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({
      id: 'P-take-replan',
      pmBinding: 'pm:P-take-replan',
      mode: 'TAKEOVER',
      sourcePath: '/tmp/existing-repo',
      workspace: dir,
      versionedTree: true,
      takeoverReviewRequired: false,
      deliveryEnabled: true,
    });
    const vs = new VersionedStore(file);
    vs.initProject('P-take-replan');
    vs.createDraft({ createdBy: 'tl' });
    const draft = vs.getOpenDraft();
    vs.applyTreeOps([{ op: 'upsertTask', task: { id: 'ROOT', taskKind: 'MILESTONE_TASK', title: 'Recovered root', intent: 'Finish the recovered project.', acceptanceCriteria: ['Project still completes.'], testStrategy: 'Run project E2E.' } }]);
    vs.close();
    store.enqueuePlanningRequest({
      id: 'replan-1',
      projectId: 'P-take-replan',
      request: { purpose: 'REPLAN_TASK', taskId: 'BIG', diagnosis: { outcome: 'TASK_TOO_LARGE' } },
    });
    store.createPlanningBatch({
      projectId: 'P-take-replan',
      batchId: 'batch-replan',
      requestIds: ['replan-1'],
      tasks: [
        {
          id: 'TL-replan',
          stage: 'tech_lead',
          state: 'DONE',
          history: [{
            type: 'ROLE_RESULT',
            role: 'tech_lead',
            outcome: 'PLANNED',
            result: { plan: { source: 'db-draft', version: draft.version } },
          }],
        },
        {
          id: 'PM-replan',
          stage: 'pm',
          dependsOn: ['TL-replan'],
          input: { planningBatchId: 'batch-replan', purpose: 'PLANNER_PM_REVIEW' },
        },
      ],
    });

    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
    });
    const pmTask = store.getTask('PM-replan');
    const prompt = definitions.pm.prepare({
      project: store.getProject('P-take-replan'),
      task: pmTask,
    }).context.v2Prompt;
    assert.match(prompt, /one-time human takeover review has already been satisfied durably/);
    assert.match(prompt, /Do NOT request another takeover\/delivery authorization/);

    const landed = definitions.pm.transition({
      task: pmTask,
      result: { outcome: 'PLAN_ACCEPTED', result: { reason: 'Technical split is sound.', startDelivery: true } },
    });
    assert.equal(landed.state, 'DONE');
    assert.equal(landed.transitionHistory.type, 'VERSIONED_TREE_PLAN_ACCEPTED');
    assert.equal(store.getProject('P-take-replan').takeoverReviewRequired, false);
    assert.equal(store.getProject('P-take-replan').deliveryEnabled, true);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('legacy TAKEOVER projects infer completed review from prior delivery and recover obsolete repeat gates', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({
      id: 'P-legacy-take',
      pmBinding: 'pm:P-legacy-take',
      mode: 'TAKEOVER',
      sourcePath: '/tmp/existing-repo',
      deliveryEnabled: false,
    });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'OLD-DONE',
      projectId: 'P-legacy-take',
      scope: 'delivery',
      stage: 'reviewer',
      state: 'DONE',
    });
    store.createTask({ taskKind: 'PLANNING',
      id: 'planner:batch-1-1:pm-review',
      projectId: 'P-legacy-take',
      scope: 'control',
      flowId: 'planner:P-legacy-take:batch-1-1',
      stage: 'pm',
      state: 'DONE',
      input: { planningBatchId: 'batch-1-1', purpose: 'PLANNER_PM_REVIEW' },
      history: [
        { type: 'HUMAN_DECISION', decision: 'approve takeover' },
        { type: 'DELIVERY_GATE', role: 'pm', enabled: true, reason: 'Human approved takeover.', at: '2026-09-25T14:03:00Z' },
      ],
    });
    store.createTask({ taskKind: 'PLANNING',
      id: 'planner:batch-4-4:pm-review',
      projectId: 'P-legacy-take',
      scope: 'control',
      flowId: 'planner:P-legacy-take:batch-4-4',
      stage: 'pm',
      state: 'NEEDS_HUMAN',
      input: { planningBatchId: 'batch-4-4', purpose: 'PLANNER_PM_REVIEW' },
      history: [{
        type: 'ROLE_RESULT',
        role: 'pm',
        outcome: 'PLAN_ACCEPTED',
        result: { reason: 'Task split accepted.', startDelivery: false },
      }],
    });

    const migrated = ensureTakeoverReviewState(store, 'P-legacy-take');
    assert.equal(migrated.takeoverReviewRequired, false);

    const recovered = recoverObsoleteTakeoverHumanGates(store, 'P-legacy-take');
    assert.deepEqual(recovered, ['planner:batch-4-4:pm-review']);
    assert.equal(store.getTask('planner:batch-4-4:pm-review').state, 'DONE');
    assert.equal(store.getTask('planner:batch-4-4:pm-review').history.at(-1).reason, 'OBSOLETE_REPEAT_TAKEOVER_GATE');
    assert.equal(store.getProject('P-legacy-take').deliveryEnabled, true, 'obsolete replan gate must restore the latest durable DELIVERY_GATE, not its own startDelivery=false');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('obsolete takeover recovery preserves a later durable closed delivery gate', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({
      id: 'P-take-closed',
      mode: 'TAKEOVER',
      takeoverReviewRequired: false,
      deliveryEnabled: true,
    });
    store.createTask({ taskKind: 'PLANNING',
      id: 'PM-old-open',
      projectId: 'P-take-closed',
      scope: 'control',
      flowId: 'planner:P-take-closed:old',
      stage: 'pm',
      state: 'DONE',
      input: { purpose: 'PLANNER_PM_REVIEW' },
      history: [{ type: 'DELIVERY_GATE', enabled: true, at: '2026-09-01T00:00:00Z' }],
    });
    store.createTask({ taskKind: 'PLANNING',
      id: 'PM-later-close',
      projectId: 'P-take-closed',
      scope: 'control',
      flowId: 'planner:P-take-closed:later',
      stage: 'pm',
      state: 'DONE',
      input: { purpose: 'PLANNER_PM_REVIEW' },
      history: [{ type: 'DELIVERY_GATE', enabled: false, at: '2026-09-02T00:00:00Z' }],
    });
    store.createTask({ taskKind: 'PLANNING',
      id: 'PM-obsolete',
      projectId: 'P-take-closed',
      scope: 'control',
      flowId: 'planner:P-take-closed:obsolete',
      stage: 'pm',
      state: 'NEEDS_HUMAN',
      input: { purpose: 'PLANNER_PM_REVIEW' },
      history: [{
        type: 'ROLE_RESULT',
        role: 'pm',
        outcome: 'PLAN_ACCEPTED',
        result: { startDelivery: true },
      }],
    });

    const recovered = recoverObsoleteTakeoverHumanGates(store, 'P-take-closed');
    assert.deepEqual(recovered, ['PM-obsolete']);
    assert.equal(store.getProject('P-take-closed').deliveryEnabled, false);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart-orphan provider loss requeues without consuming or escalating attempts', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-restart-orphan' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'T-restart-orphan',
      projectId: 'P-restart-orphan',
      stage: 'developer',
      state: 'WORKING',
      execution: {
        provider: 'fake',
        externalId: 'lost-memory-handle',
        attemptId: 'P-restart-orphan:T-restart-orphan:developer:7',
        resources: ['gpu'],
      },
      history: [
        { type: 'SYSTEM_INTERRUPTION', role: 'developer', failure: 'AGENT_SESSION_RUN_NOT_FOUND', consumeAttempt: false, restartOrphan: true },
        { type: 'SYSTEM_INTERRUPTION', role: 'developer', failure: 'AGENT_SESSION_RUN_NOT_FOUND', consumeAttempt: false, restartOrphan: true },
        { type: 'SYSTEM_INTERRUPTION', role: 'developer', failure: 'AGENT_SESSION_RUN_NOT_FOUND', consumeAttempt: false, restartOrphan: true },
      ],
    });

    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      async start() { throw new Error('not used'); },
      async poll() {
        return {
          state: 'LOST',
          failure: 'AGENT_SESSION_RUN_NOT_FOUND',
          consumeAttempt: false,
          restartOrphan: true,
        };
      },
      async cancel() {},
    });
    const resources = new ResourcePool({ gpu: 1 });
    resources.recover(store.listTasks('P-restart-orphan'));
    const supervisor = new V2Supervisor({ store, providers, resources });

    await supervisor.audit('P-restart-orphan');
    const task = store.getTask('T-restart-orphan');
    assert.equal(task.state, 'READY');
    assert.equal(task.stage, 'developer');
    assert.equal(task.execution, null);
    assert.equal(task.history.at(-1)?.failure, 'AGENT_SESSION_RUN_NOT_FOUND');
    assert.equal(task.history.at(-1)?.consumeAttempt, false);
    assert.equal(task.history.at(-1)?.restartOrphan, true);
    assert.deepEqual(resources.snapshot(), []);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart-orphan unknown legacy provider requeues without consuming an attempt', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-legacy-provider' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'T-legacy-provider',
      projectId: 'P-legacy-provider',
      stage: 'tech_lead',
      state: 'WORKING',
      execution: {
        provider: 'pydantic-v2',
        externalId: 'legacy-runtime-handle',
        attemptId: 'P-legacy-provider:T-legacy-provider:tech_lead:4',
        resources: [],
      },
    });

    const providers = new ProviderRegistry();
    const resources = new ResourcePool({});
    const supervisor = new V2Supervisor({ store, providers, resources });

    await supervisor.audit('P-legacy-provider');
    const task = store.getTask('T-legacy-provider');
    assert.equal(task.state, 'READY');
    assert.equal(task.stage, 'tech_lead');
    assert.equal(task.execution, null);
    assert.equal(task.history.at(-1)?.failure, 'PROVIDER_UNAVAILABLE_AFTER_RESTART: pydantic-v2');
    assert.equal(task.history.at(-1)?.consumeAttempt, false);
    assert.equal(task.history.at(-1)?.restartOrphan, true);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unified Project Debugger routes a system-blocked oversized task to Tech Lead', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-system-debug' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'T-blocked',
      projectId: 'P-system-debug',
      scope: 'delivery',
      stage: 'developer',
      state: 'SYSTEM_BLOCKED',
      history: [{ type: 'SYSTEM_INTERRUPTION', failure: 'STALLED_AGENT_RUN' }],
    });
    store.createTask({ taskKind: 'DIAGNOSTIC',
      id: 'debug:T-blocked:1',
      projectId: 'P-system-debug',
      scope: 'control',
      flowId: 'debug:T-blocked:1',
      stage: 'project_debugger',
      state: 'READY',
      input: {
        blockedTaskId: 'T-blocked',
        systemIncident: {
          blockedTask: {
            id: 'T-blocked',
            stage: 'developer',
            state: 'SYSTEM_BLOCKED',
            recentHistory: [{ type: 'SYSTEM_INTERRUPTION', failure: 'STALLED_AGENT_RUN' }],
          },
        },
      },
    });
    const planning = [];
    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
      enqueuePlanning: request => planning.push(request),
    });
    const task = store.getTask('debug:T-blocked:1');
    const prepared = definitions.project_debugger.prepare({ task });
    assert.match(prepared.context.v2Prompt, /root cause across BOTH project\/task causes and execution\/runtime\/model causes/i);
    assert.match(prepared.context.v2Prompt, /STALLED_AGENT_RUN/);

    const next = definitions.project_debugger.transition({
      task,
      result: {
        outcome: 'TASK_TOO_LARGE',
        summary: 'The task shape is causing repeated model stalls.',
        result: {
          reason: 'The developer must inspect and validate too much in one attempt.',
          guidance: 'Split the end-to-end campaign work into smaller independently executable slices.',
          evidence: ['Repeated STALLED_AGENT_RUN with expanding inspection scope.'],
          affectedComponent: 'delivery-plan',
        },
      },
    });
    assert.equal(next.state, 'DONE');
    const blocked = store.getTask('T-blocked');
    assert.equal(blocked.state, 'WAITING_REPLAN');
    assert.equal(blocked.stage, 'developer');
    assert.equal(planning.length, 1);
    assert.equal(planning[0].request.purpose, 'REPLAN_TASK');
    assert.equal(planning[0].request.taskId, 'T-blocked');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unified Project Debugger hands true runtime failures to a human without reclassifying the business task', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-runtime-debug' });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'T-runtime',
      projectId: 'P-runtime-debug',
      scope: 'delivery',
      stage: 'tester',
      state: 'SYSTEM_BLOCKED',
    });
    store.createTask({ taskKind: 'DIAGNOSTIC',
      id: 'debug:T-runtime:1',
      projectId: 'P-runtime-debug',
      scope: 'control',
      flowId: 'debug:T-runtime:1',
      stage: 'project_debugger',
      state: 'READY',
      input: { blockedTaskId: 'T-runtime', systemIncident: { incidents: [{ failure: 'TOOL_PERMISSION_DENIED' }] } },
    });
    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
    });
    const task = store.getTask('debug:T-runtime:1');
    const next = definitions.project_debugger.transition({
      task,
      result: {
        outcome: 'SYSTEM_RUNTIME_FAILURE',
        summary: 'Host tool permission is broken.',
        result: {
          reason: 'The runtime denied the required tool before business verification could run.',
          guidance: 'Repair the host tool permission.',
          evidence: ['TOOL_PERMISSION_DENIED'],
          affectedComponent: 'openclaw-runtime',
        },
      },
    });
    assert.equal(next.state, 'NEEDS_HUMAN');
    assert.equal(next.transitionHistory.type, 'SYSTEM_DIAGNOSIS');
    assert.equal(next.transitionHistory.role, 'project_debugger');
    assert.equal(next.transitionHistory.blockedTaskId, 'T-runtime');
    assert.equal(store.getTask('T-runtime').state, 'SYSTEM_BLOCKED');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler stops infinite role-start retries by entering SYSTEM_BLOCKED', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-start-failure' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-start-failure', projectId: 'P-start-failure', stage: 'developer' });

    const roleRegistry = new RoleRegistry();
    roleRegistry.register('developer', {
      prepare: () => ({ provider: 'broken' }),
      transition: () => ({ state: 'DONE' }),
    });
    const providers = new ProviderRegistry();
    providers.register({
      id: 'broken',
      async start() { throw new Error('provider cannot start role'); },
      async poll() { return { state: 'LOST' }; },
      async cancel() {},
    });
    const scheduler = new V2Scheduler({
      store,
      roles: roleRegistry,
      providers,
      resources: new ResourcePool({}),
    });

    await scheduler.tick('P-start-failure');
    assert.equal(store.getTask('T-start-failure').state, 'READY');
    await scheduler.tick('P-start-failure');
    assert.equal(store.getTask('T-start-failure').state, 'READY');
    await scheduler.tick('P-start-failure');

    const blocked = store.getTask('T-start-failure');
    assert.equal(blocked.state, 'SYSTEM_BLOCKED');
    assert.equal(
      blocked.history.filter(entry => entry?.type === 'SYSTEM_INTERRUPTION').length,
      3,
    );
    assert.equal(blocked.history.at(-1)?.failure, 'provider cannot start role');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PM is the only business role that may create a human-decision gate', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-routing' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-routing', projectId: 'P-routing', stage: 'tester' });
    const planningRequests = [];
    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
      enqueuePlanning: ({ request }) => planningRequests.push(request),
    });
    const task = store.getTask('T-routing');

    const wrongApproach = definitions.project_debugger.transition({
      task: {
        ...task,
        history: [
          { type: 'ROLE_RESULT', role: 'project_debugger', outcome: 'WRONG_IMPLEMENTATION_APPROACH' },
          { type: 'ROLE_RESULT', role: 'project_debugger', outcome: 'WRONG_IMPLEMENTATION_APPROACH' },
          { type: 'ROLE_RESULT', role: 'project_debugger', outcome: 'WRONG_IMPLEMENTATION_APPROACH' },
        ],
      },
      result: {
        outcome: 'WRONG_IMPLEMENTATION_APPROACH',
        result: { guidance: 'Fix the implementation and rerun independent verification.' },
      },
    });
    assert.equal(wrongApproach.stage, 'developer');
    assert.equal(wrongApproach.state, 'READY');

    const requirement = definitions.project_debugger.transition({
      task,
      result: {
        outcome: 'REQUIREMENT_DECISION_REQUIRED',
        summary: 'Requirements conflict.',
        result: { guidance: 'PM should resolve intended product behavior.' },
      },
    });
    assert.equal(requirement.stage, 'pm');
    assert.equal(requirement.state, 'READY');

    const unknown = definitions.project_debugger.transition({
      task,
      result: { outcome: 'UNKNOWN_PROJECT_CAUSE', summary: 'Project evidence cannot resolve the product intent.' },
    });
    assert.equal(unknown.stage, 'pm');
    assert.equal(unknown.state, 'READY');

    const techLeadEscalation = definitions.tech_lead.transition({
      task: { ...task, scope: 'control', stage: 'tech_lead', taskKind: 'PLANNING' },
      result: { outcome: 'UNRESOLVED_PRODUCT_DECISION', summary: 'Need product intent.' },
    });
    assert.equal(techLeadEscalation.stage, 'pm');
    assert.equal(techLeadEscalation.state, 'READY');

    const productDecision = definitions.pm.transition({
      task: { ...task, scope: 'delivery' },
      result: {
        outcome: 'PRODUCT_DECISION',
        summary: 'Existing product intent is sufficient.',
        result: {
          reason: 'The existing spec already defines the behavior.',
          decision: 'Preserve progression and equipped item state across save/continue.',
          guidance: 'Amend the smallest affected task/subtree and add real-button E2E.',
        },
      },
    });
    assert.equal(productDecision.stage, 'developer');
    assert.equal(productDecision.state, 'WAITING_REPLAN');
    assert.equal(productDecision.transitionHistory.type, 'PRODUCT_DECISION');
    assert.equal(planningRequests.at(-1).purpose, 'PRODUCT_DECISION_REPLAN');
    assert.equal(planningRequests.at(-1).taskId, task.id);

    const humanGate = definitions.pm.transition({
      task: { ...task, scope: 'delivery' },
      result: {
        outcome: 'NEEDS_HUMAN',
        summary: 'Two valid product behaviors remain.',
        result: {
          reason: 'No prior user decision resolves the conflict.',
          questions: ['Should save/continue preserve equipped items?'],
        },
      },
    });
    assert.equal(humanGate.state, 'NEEDS_HUMAN');
    assert.equal(humanGate.transitionHistory.role, 'pm');
    assert.equal(humanGate.transitionHistory.type, 'PM_HUMAN_DECISION');

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default LLM roles request the shared local-llm resource only for llamacpp models', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-model-resource' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-local', projectId: 'P-model-resource', stage: 'developer' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-remote', projectId: 'P-model-resource', stage: 'reviewer' });
    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      providerId: 'fake',
      codeProviderId: 'ariad-code',
      resolveRoleExecutionMetadata: role => ({
        modelRef: role === 'developer' ? 'llamacpp/qwen3.8-27b' : 'openai-codex/gpt-5.6-codex',
      }),
    });

    const local = definitions.developer.prepare({ task: store.getTask('T-local') });
    const remote = definitions.reviewer.prepare({ task: store.getTask('T-remote') });
    assert.deepEqual(local.resources, ['local-llm']);
    assert.equal(local.context.roleModelRef, 'llamacpp/qwen3.8-27b');
    assert.deepEqual(local.context.roleModels, { developer: 'llamacpp/qwen3.8-27b' });
    assert.deepEqual(remote.resources, []);
    assert.equal(remote.context.roleModelRef, 'openai-codex/gpt-5.6-codex');
    assert.deepEqual(remote.context.roleModels, { reviewer: 'openai-codex/gpt-5.6-codex' });
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shared scoped resource pool serializes local LLM work across projects without blocking remote work', async () => {
  const a = tempDb();
  const b = tempDb();
  const cdir = tempDb();
  try {
    const storeA = new SQLiteV2Store(a.file);
    const storeB = new SQLiteV2Store(b.file);
    const storeC = new SQLiteV2Store(cdir.file);
    storeA.createProject({ id: 'P-A' });
    storeB.createProject({ id: 'P-B' });
    storeC.createProject({ id: 'P-C' });
    storeA.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-A', projectId: 'P-A', stage: 'developer' });
    storeB.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-B', projectId: 'P-B', stage: 'developer' });
    storeC.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-C', projectId: 'P-C', stage: 'developer' });

    const starts = [];
    const provider = {
      id: 'fake',
      async start(spec) {
        starts.push(spec.taskId);
        return { externalId: `run-${spec.taskId}` };
      },
      async poll() { return { state: 'RUNNING' }; },
      async cancel() { return { state: 'CANCELLED', confirmed: true }; },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);

    const makeRoles = resources => {
      const registry = new RoleRegistry();
      registry.register('developer', {
        prepare: () => ({ provider: 'fake', resources }),
        transition: () => ({ state: 'DONE' }),
      });
      return registry;
    };

    const shared = new ResourcePool({ 'local-llm': 1 });
    const resourceA = new ScopedResourcePool(shared, 'P-A');
    const resourceB = new ScopedResourcePool(shared, 'P-B');
    const resourceC = new ScopedResourcePool(shared, 'P-C');
    const schedulerA = new V2Scheduler({ store: storeA, roles: makeRoles(['local-llm']), providers, resources: resourceA });
    const schedulerB = new V2Scheduler({ store: storeB, roles: makeRoles(['local-llm']), providers, resources: resourceB });
    const schedulerC = new V2Scheduler({ store: storeC, roles: makeRoles([]), providers, resources: resourceC });

    await schedulerA.tick('P-A');
    assert.deepEqual(starts, ['T-A']);
    assert.equal(storeA.getTask('T-A').state, 'WORKING');

    await schedulerB.tick('P-B');
    assert.deepEqual(starts, ['T-A']);
    assert.equal(storeB.getTask('T-B').state, 'READY');

    await schedulerC.tick('P-C');
    assert.deepEqual(starts, ['T-A', 'T-C']);
    assert.equal(storeC.getTask('T-C').state, 'WORKING');

    resourceA.release('T-A');
    await schedulerB.tick('P-B');
    assert.deepEqual(starts, ['T-A', 'T-C', 'T-B']);
    assert.equal(storeB.getTask('T-B').state, 'WORKING');

    storeA.close();
    storeB.close();
    storeC.close();
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
    fs.rmSync(cdir.dir, { recursive: true, force: true });
  }
});

test('PM review resumed by HUMAN_DECISION runs after request is marked PLANNED', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-reviewed', deliveryEnabled: false });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'D1', projectId: 'P-reviewed', scope: 'delivery', stage: 'developer',
      state: 'READY',
    });
    store.createTask({ taskKind: 'PLANNING',
      id: 'PM', projectId: 'P-reviewed', scope: 'control',
      flowId: 'planner:P-reviewed:batch-1-1', stage: 'pm', state: 'READY',
      input: { purpose: 'PLANNER_PM_REVIEW' },
      history: [{ type: 'HUMAN_DECISION', decision: 'Approve the validated plan' }],
    });
    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      async start(spec) { return { externalId: spec.taskId }; },
      async poll() { return { state: 'RUNNING' }; },
      async cancel() { return { confirmed: true }; },
    });
    const roleRegistry = new RoleRegistry();
    roleRegistry.register('pm', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => ({ state: 'DONE' }),
    });
    roleRegistry.register('developer', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => ({ state: 'DONE' }),
    });
    const scheduler = new V2Scheduler({
      store, roles: roleRegistry, providers, resources: new ResourcePool({}),
    });
    const tick = await scheduler.tick('P-reviewed');
    assert.deepEqual(tick.started, ['PM']);
    assert.equal(store.getTask('D1').state, 'READY');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('issue intake deduplicates sources and tracks triage assignment through planning', () => {
  const { dir, file } = tempDb();
  const store = new SQLiteV2Store(file);
  try {
    store.createProject({ id: 'P-issue' });
    const first = store.createIssue({
      projectId: 'P-issue',
      source: { kind: 'github', ref: 'owner/repo#42' },
      title: 'CH21 reinforcement overlap',
      description: 'A rescued ally and enemy reinforcement can occupy the same live grid cell.',
      severity: 'high',
      blocking: true,
      affectedComponent: 'content.m4.ch21',
    });
    const duplicate = store.createIssue({
      projectId: 'P-issue',
      source: { kind: 'github', ref: 'owner/repo#42' },
      title: 'CH21 reinforcement overlap',
      description: 'A rescued ally and enemy reinforcement can occupy the same live grid cell.',
      severity: 'high',
      blocking: true,
      affectedComponent: 'content.m4.ch21',
    });
    assert.equal(first.id, duplicate.id);
    assert.equal(store.listIssues('P-issue').length, 1);

    const request = store.enqueuePlanningRequest({
      id: 'R-issue',
      projectId: 'P-issue',
      request: { purpose: 'TRIAGE_AND_ASSIGN_ISSUE', issueId: first.id },
    });
    store.updateIssue(first.id, { state: 'TRIAGE_PENDING', planningRequestId: request.id });
    store.createTask({ taskKind: 'MILESTONE_TASK',
      id: 'repair-ch21',
      projectId: 'P-issue',
      stage: 'developer',
      state: 'READY',
      issueRefs: [first.id],
    });
    store.createPlanningBatch({
      projectId: 'P-issue',
      batchId: 'B-issue',
      requestIds: ['R-issue'],
      tasks: [{
        id: 'planner:B-issue:noop',
        stage: 'tech_lead',
        taskKind: 'PLANNING',
        input: { purpose: 'PLANNER_DEPENDENCIES' },
      }],
    });
    store.completePlanningBatch('P-issue', 'B-issue');
    const assigned = store.getIssue(first.id);
    assert.equal(assigned.state, 'ASSIGNED');
    assert.deepEqual(assigned.assignedTaskIds, ['repair-ch21']);
    assert.equal(assigned.triage.disposition, 'ASSIGNED');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delivery role reports cross-scope issue without blocking source task', async () => {
  const { dir, file } = tempDb();
  const store = new SQLiteV2Store(file);
  try {
    store.createProject({ id: 'P-cross-scope' });
    const reported = [];
    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      artifactRoot: dir,
      reportIssue: issue => {
        reported.push(issue);
        return store.createIssue({ projectId: 'P-cross-scope', id: 'issue:P-cross-scope:ch21', ...issue });
      },
    });
    const followUp = await definitions.tester.afterPersist({
      task: { id: 'regression-m4', projectId: 'P-cross-scope', stage: 'tester', history: [] },
      result: {
        outcome: 'PASS',
        result: {
          discoveredIssues: [{
            title: 'CH21 live-unit overlap',
            description: 'Two alive units share one cell and one becomes unselectable.',
            severity: 'high',
            blocking: true,
            affectedComponent: 'content.m4.ch21',
            evidence: [{ cell: [0, 3] }],
          }],
        },
      },
    });
    assert.equal(reported.length, 1);
    assert.equal(reported[0].sourceTaskId, 'regression-m4');
    assert.equal(reported[0].reportedBy, 'tester');
    assert.equal(followUp?.patch?.state, undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('previously reported issue cannot veto source task PASS before TL triage', async () => {
  const { dir, file } = tempDb();
  const store = new SQLiteV2Store(file);
  try {
    store.createProject({ id: 'P-early-issue' });
    store.createIssue({
      projectId: 'P-early-issue',
      id: 'issue:P-early-issue:blocker',
      source: { kind: 'internal-role', ref: 'T1:tester' },
      sourceTaskId: 'T1',
      reportedBy: 'tester',
      title: 'Early blocker',
      description: 'Reported before terminal role result.',
      blocking: true,
      severity: 'high',
    });
    const definitions = createDefaultV2Roles({
      store,
      workspace: dir,
      artifactRoot: dir,
      reportIssue: issue => store.createIssue({ projectId: 'P-early-issue', ...issue }),
    });
    const followUp = await definitions.tester.afterPersist({
      task: { id: 'T1', projectId: 'P-early-issue', stage: 'tester', history: [] },
      result: { outcome: 'PASS', result: { criteria: [], interfaceVerifications: [] } },
    });
    assert.equal(followUp?.patch?.state, undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assigned issue resolves automatically only after every repair task is DONE', () => {
  const { dir, file } = tempDb();
  const store = new SQLiteV2Store(file);
  try {
    store.createProject({ id: 'P-resolve-issue' });
    const issue = store.createIssue({
      projectId: 'P-resolve-issue',
      id: 'issue:P-resolve-issue:1',
      source: { kind: 'user', ref: 'chat:1' },
      title: 'Repair me',
      description: 'Needs two bounded repairs.',
      blocking: true,
    });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'R1', projectId: 'P-resolve-issue', state: 'DONE' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'R2', projectId: 'P-resolve-issue', state: 'READY' });
    store.updateIssue(issue.id, { state: 'ASSIGNED', assignedTaskIds: ['R1', 'R2'] });
    assert.deepEqual(store.reconcileAssignedIssues('P-resolve-issue'), []);
    assert.equal(store.getIssue(issue.id).state, 'ASSIGNED');
    const r2 = store.getTask('R2');
    store.updateTask('R2', r2.version, { state: 'DONE' });
    assert.deepEqual(store.reconcileAssignedIssues('P-resolve-issue'), [issue.id]);
    assert.equal(store.getIssue(issue.id).state, 'RESOLVED');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TL routes triaged fix into the issue queue without touching the delivery DAG', () => {
  const { dir, file } = tempDb();
  const store = new SQLiteV2Store(file);
  try {
    store.createProject({ id: 'P-insert' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'done', projectId: 'P-insert', state: 'DONE' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'active', projectId: 'P-insert', state: 'WORKING', dependsOn: ['done'] });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'next', projectId: 'P-insert', state: 'READY', dependsOn: ['active'] });
    const issue = store.createIssue({ projectId: 'P-insert', title: 'Independent regression', description: 'Needs fix' });
    const before = store.getTask('active');
    assert.throws(() => store.insertTriagedFixTask({ projectId: 'P-insert', issueId: issue.id, actor: 'tester', task: { id: 'fix' } }), /REQUIRES_TECH_LEAD/);
    // Former cycle case: a fix may depend on 'next' without creating a
    // cycle, because nothing in the tree is rewired to depend on the fix.
    store.insertTriagedFixTask({ projectId: 'P-insert', issueId: issue.id, actor: 'tech_lead', task: { id: 'fix2', title: 'Dependent fix', dependsOn: ['next'] }, beforeTaskIds: ['next'] });
    assert.deepEqual(store.getTask('next').dependsOn, ['active']);
    // A WORKING task named in beforeTaskIds no longer blocks insertion:
    // it is a triage record, not a gate.
    const projectVersion = store.getProject('P-insert').version;
    store.insertTriagedFixTask({ projectId: 'P-insert', issueId: issue.id, actor: 'tech_lead', task: { id: 'fix', title: 'Fix regression', dependsOn: ['done'] }, beforeTaskIds: ['active'] });
    assert.deepEqual(store.getTask('next').dependsOn, ['active']);
    assert.equal(store.getTask('active').version, before.version);
    assert.equal(store.getProject('P-insert').version, projectVersion);
    assert.equal(store.getIssue(issue.id).state, 'ASSIGNED');
    assert.deepEqual(store.getIssue(issue.id).assignedTaskIds, ['fix2', 'fix']);
    const fix = store.getTask('fix');
    assert.deepEqual(fix.issueRefs, [issue.id]);
    assert.equal(fix.queue, 'issue');
    assert.equal(fix.parentId, null);
    assert.equal(fix.milestoneId, null);
  } finally {
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
