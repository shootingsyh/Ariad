import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawRuntimeAdapter } from '../dist/openclaw-runtime-adapter.js';
import { OpenClawProjectAgentAdapter } from '../dist/openclaw-project-agent-adapter.js';
import { AriadSupervisor } from '../dist/ariad-supervisor.js';
import { AriadProjectManager } from '../runtime/project-manager.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SQLiteRunStore } from '../../../src/sqlite-run-store.js';

test('OpenClawRuntimeAdapter translates Ariad Run lifecycle to subagent lifecycle', async () => {
  const calls = [];
  const subagent = {
    async run(input) {
      calls.push(['run', input]);
      return { runId: 'oc-run-1', sessionKey: input.sessionKey };
    },
    async waitForRun() {
      calls.push(['wait']);
      return {
        status: 'ok',
        terminalReply: { text: JSON.stringify({ executionStatus: 'COMPLETED', outcome: 'PASS', result: { ok: true } }) },
      };
    },
  };
  const adapter = new OpenClawRuntimeAdapter({
    subagent,
    agentId: 'worker',
    provider: 'fake',
    model: 'role-model',
    renderMessage: (role, context) => `ROLE=${role};TASK=${context.taskId}`,
  });

  const handle = await adapter.start({ runId: 'ariad-run-1', role: 'reviewer', context: { taskId: 'T1', workspace: '/tmp/ariad-workspace' } });
  assert.equal(handle.externalId, 'oc-run-1');
  assert.equal(calls[0][1].sessionKey, 'agent:worker:subagent:ariad-ariad-run-1');
  assert.equal(calls[0][1].provider, 'fake');
  assert.equal(calls[0][1].model, 'role-model');
  assert.equal(calls[0][1].deliver, false);
  assert.equal(calls[0][1].cwd, '/tmp/ariad-workspace');
  assert.equal(calls[0][1].message, 'ROLE=reviewer;TASK=T1');

  const result = await adapter.poll(handle);
  assert.deepEqual(result, { state: 'COMPLETED', outcome: 'PASS', result: { ok: true } });
});

test('OpenClawRuntimeAdapter falls back to full session message when terminal reply is truncated', async () => {
  const full = JSON.stringify({
    executionStatus: 'COMPLETED',
    outcome: 'PLANNED',
    result: { projectModel: { payload: 'x'.repeat(5000) } },
  });
  const adapter = new OpenClawRuntimeAdapter({
    subagent: {
      async run(input) { return { runId: 'oc-truncated', sessionKey: input.sessionKey }; },
      async waitForRun() { return { status: 'ok', terminalReply: { text: full.slice(0, 4096) } }; },
      async getSessionMessages() { return { messages: [{ role: 'assistant', content: full }] }; },
    },
  });
  const handle = await adapter.start({ runId: 'r-truncated', role: 'tech_lead', context: {} });
  const result = await adapter.poll(handle);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.outcome, 'PLANNED');
  assert.equal(result.result.projectModel.payload.length, 5000);
});

test('OpenClawRuntimeAdapter omits cwd when no project workspace is supplied', async () => {
  let inputSeen = null;
  const adapter = new OpenClawRuntimeAdapter({
    subagent: {
      async run(input) { inputSeen = input; return { runId: 'oc-no-cwd' }; },
      async waitForRun() { return { status: 'timeout' }; },
    },
  });
  await adapter.start({ runId: 'r-no-cwd', role: 'reviewer', context: { taskId: 'probe' } });
  assert.equal(Object.hasOwn(inputSeen, 'cwd'), false);
});

test('OpenClawRuntimeAdapter treats observation timeout as nonterminal', async () => {
  const adapter = new OpenClawRuntimeAdapter({
    subagent: {
      async run() { return { runId: 'oc-run-2' }; },
      async waitForRun() { return { status: 'timeout' }; },
    },
  });
  const handle = await adapter.start({ runId: 'r2', role: 'developer', context: {} });
  assert.deepEqual(await adapter.poll(handle), { state: 'RUNNING' });
});

test('OpenClawProjectAgentAdapter routes durable Ariad events to the bound project conversation', async () => {
  const calls = [];
  const adapter = new OpenClawProjectAgentAdapter({
    gateway: {
      async request(method, params, options) {
        calls.push({ method, params, options });
        return { ok: true };
      },
    },
  });
  const event = {
    version: 1,
    id: 'p1:1:1',
    projectId: 'p1',
    type: 'NEEDS_HUMAN',
    createdAt: '2026-09-17T00:00:00.001Z',
    payload: { questions: ['Choose A or B'] },
  };

  await adapter.notify({
    binding: { host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:project-thread' },
    event,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sessions.send');
  assert.equal(calls[0].params.key, 'agent:main:project-thread');
  assert.equal(calls[0].params.agentId, 'main');
  assert.equal(calls[0].params.idempotencyKey, 'ariad:p1:1:1');
  assert.match(calls[0].params.message, /minimum concrete question/);
  assert.match(calls[0].params.message, /action="decide"/);
  assert.match(calls[0].params.message, /Choose A or B/);
  assert.equal(calls[0].options.timeoutMs, 35_000);
});

test('OpenClawProjectAgentAdapter accepts decisions only from the bound Project Agent session', async () => {
  const adapter = new OpenClawProjectAgentAdapter({ gateway: { async request() { return { ok: true }; } } });
  const binding = { host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:project-thread' };
  let submitted = null;
  const result = await adapter.submitDecision({
    binding,
    requester: { agentId: 'main', sessionKey: 'agent:main:project-thread' },
    decision: '  choose option A  ',
    submit: async (decision) => { submitted = decision; return { resumed: true }; },
  });
  assert.equal(submitted, 'choose option A');
  assert.deepEqual(result, { resumed: true });
  await assert.rejects(() => adapter.submitDecision({
    binding,
    requester: { agentId: 'main', sessionKey: 'agent:main:other-thread' },
    decision: 'choose option B',
    submit: async () => ({}),
  }), /bound Project Agent session/);
});

test('AriadProjectManager initializes a new project workspace as a Git repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-project-git-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('git-ready');
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: project.workspace, encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: project.workspace, encoding: 'utf8' }).trim();
    assert.equal(inside, 'true');
    assert.equal(branch, 'main');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AriadSupervisor owns controller lifecycle by reconciling durable desired state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    manager.create('alpha');
    manager.create('beta');
    manager.setDesiredState('alpha', 'RUNNING');
    const events = [];
    const supervisor = new AriadSupervisor({
      manager,
      reconcileIntervalMs: 60_000,
      createController: (project) => ({
        async start() { events.push(`start:${project.id}`); },
        async stop() { events.push(`stop:${project.id}`); },
      }),
    });

    await supervisor.start();
    assert.equal(supervisor.status('alpha').active, true);
    assert.equal(supervisor.status('beta').active, false);

    await supervisor.ensureRunning('beta');
    assert.equal(supervisor.status('beta').active, false, 'request path only records desired state');
    await supervisor.reconcile();
    assert.equal(supervisor.status('beta').active, true);

    await supervisor.ensureStopped('alpha');
    assert.equal(supervisor.status('alpha').active, true, 'request path does not directly stop controller');
    await supervisor.reconcile();
    assert.equal(supervisor.status('alpha').active, false);

    assert.deepEqual(events, ['start:alpha', 'start:beta', 'stop:alpha']);
    assert.equal(manager.status('alpha').desiredState, 'STOPPED');
    assert.equal(manager.status('beta').desiredState, 'RUNNING');
    await supervisor.stop();
    assert.deepEqual(events, ['start:alpha', 'start:beta', 'stop:alpha', 'stop:beta']);
    assert.equal(manager.status('beta').desiredState, 'RUNNING', 'host shutdown must not rewrite project intent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AriadSupervisor replaces a settled controller after recording a human decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-decision-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('decision', {
      goal: 'ship it',
      projectAgent: { host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:decision' },
    });
    const projectDir = join(project.root, '.ariad', 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'project-agent-events.jsonl'), `${JSON.stringify({
      version: 1,
      id: 'decision:e1',
      projectId: project.id,
      type: 'NEEDS_HUMAN',
      createdAt: '2026-09-17T18:00:00.000Z',
      payload: { phase: 'PLAN_REVIEW' },
      delivery: 'PENDING',
    })}\n`);
    const events = [];
    const supervisor = new AriadSupervisor({
      manager,
      reconcileIntervalMs: 60_000,
      createController: (value) => ({
        async start() { events.push(`start:${value.id}`); },
        async stop() { events.push(`stop:${value.id}`); },
      }),
    });
    manager.setDesiredState(project.id, 'RUNNING');
    await supervisor.start();
    const response = await supervisor.submitDecision(project.id, 'Keep the public API stable.');
    assert.equal(response.resumed.record.decision, 'Keep the public API stable.');
    assert.equal(response.project.executionState, 'IDLE');
    assert.deepEqual(events, ['start:decision', 'stop:decision'], 'decision request must not launch a controller inline');

    await supervisor.reconcile();
    assert.deepEqual(events, ['start:decision', 'stop:decision', 'start:decision']);
    await supervisor.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('AriadSupervisor status surfaces the latest durable run failure without a live controller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-status-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('failed-status');
    const store = new SQLiteRunStore(project.stateDb);
    const run = store.create({
      taskId: '__project_plan__',
      role: 'tech_lead',
      runtimeKey: 'openclaw',
      runtimeId: 'openclaw-subagent',
      context: {},
    });
    store.update(run.id, { state: 'FAILED', failure: 'POLL_TIMEOUT' });
    store.close();

    const supervisor = new AriadSupervisor({
      manager,
      createController: () => ({ async start() {}, async stop() {} }),
    });
    const status = supervisor.status(project.id);

    assert.equal(status.active, false);
    assert.equal(status.lastRun.id, run.id);
    assert.equal(status.lastRun.role, 'tech_lead');
    assert.equal(status.lastRun.failure, 'POLL_TIMEOUT');
    assert.deepEqual(status.failure, {
      source: 'run',
      runId: run.id,
      role: 'tech_lead',
      failure: 'POLL_TIMEOUT',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('start clears a settled failed controller so supervisor reconciliation can restart it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-restart-failed-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('retry-failed');
    manager.setDesiredState(project.id, 'RUNNING');

    const controllers = [];
    const supervisor = new AriadSupervisor({
      manager,
      reconcileIntervalMs: 60_000,
      createController: () => {
        const controller = {
          active: controllers.length > 0,
          phase: controllers.length > 0 ? 'RUNNING' : 'FAILED',
          async start() {},
          async stop() { this.active = false; },
          status() { return { active: this.active, phase: this.phase, error: this.phase === 'FAILED' ? 'boom' : null }; },
        };
        controllers.push(controller);
        return controller;
      },
    });

    await supervisor.start();
    controllers[0].active = false;
    controllers[0].phase = 'FAILED';
    assert.equal(supervisor.status(project.id).executionState, 'FAILED');

    await supervisor.ensureRunning(project.id);
    assert.equal(supervisor.status(project.id).active, false, 'start request must not launch controller inline');

    await supervisor.reconcile();
    assert.equal(controllers.length, 2);
    assert.equal(supervisor.status(project.id).active, true);
    assert.equal(supervisor.status(project.id).executionState, 'RUNNING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('successful project execution state is durable and does not auto-rerun after supervisor restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-success-state-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('finished');
    manager.setDesiredState(project.id, 'RUNNING');
    let starts = 0;

    const supervisor = new AriadSupervisor({
      manager,
      reconcileIntervalMs: 60_000,
      createController: () => ({
        active: false,
        phase: 'SUCCEEDED',
        async start() { starts += 1; },
        async stop() {},
        status() { return { active: this.active, phase: this.phase, error: null }; },
      }),
    });

    await supervisor.start();
    assert.equal(starts, 1);
    assert.equal(supervisor.status(project.id).executionState, 'SUCCEEDED');
    await supervisor.reconcile();
    assert.equal(supervisor.status(project.id).controller, null, 'settled successful controller must be removed');
    await supervisor.stop();

    const reopenedManager = new AriadProjectManager({ projectsRoot: dir });
    assert.equal(reopenedManager.status(project.id).executionState, 'SUCCEEDED');

    const restarted = new AriadSupervisor({
      manager: reopenedManager,
      reconcileIntervalMs: 60_000,
      createController: () => ({
        async start() { starts += 1; },
        async stop() {},
        status() { return { active: true, phase: 'RUNNING' }; },
      }),
    });
    await restarted.start();
    assert.equal(starts, 1, 'durable SUCCEEDED project must not restart merely because desiredState remains RUNNING');
    assert.equal(restarted.status(project.id).executionState, 'SUCCEEDED');
    await restarted.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed project execution state is durable and does not auto-rerun after supervisor restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-failed-state-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('failed');
    manager.setDesiredState(project.id, 'RUNNING');
    let starts = 0;

    const supervisor = new AriadSupervisor({
      manager,
      reconcileIntervalMs: 60_000,
      createController: () => ({
        active: false,
        phase: 'FAILED',
        async start() { starts += 1; },
        async stop() {},
        status() { return { active: this.active, phase: this.phase, error: 'boom' }; },
      }),
    });

    await supervisor.start();
    assert.equal(starts, 1);
    assert.equal(supervisor.status(project.id).executionState, 'FAILED');
    await supervisor.reconcile();
    assert.equal(supervisor.status(project.id).controller, null, 'settled failed controller must be removed');
    await supervisor.stop();

    const reopenedManager = new AriadProjectManager({ projectsRoot: dir });
    assert.equal(reopenedManager.status(project.id).executionState, 'FAILED');

    const restarted = new AriadSupervisor({
      manager: reopenedManager,
      reconcileIntervalMs: 60_000,
      createController: () => ({
        async start() { starts += 1; },
        async stop() {},
        status() { return { active: true, phase: 'RUNNING' }; },
      }),
    });
    await restarted.start();
    assert.equal(starts, 1, 'durable FAILED project must not auto-retry after restart');

    await restarted.ensureRunning(project.id);
    assert.equal(restarted.status(project.id).executionState, 'IDLE', 'explicit start resets FAILED for a manual retry');
    await restarted.reconcile();
    assert.equal(starts, 2, 'explicit start allows supervisor-owned retry');
    await restarted.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NEEDS_HUMAN remains durable across restart and resumes through supervisor reconciliation after decide', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-human-state-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('human-wait', {
      goal: 'ship it',
      projectAgent: { host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:human-wait' },
    });
    const projectDir = join(project.root, '.ariad', 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'project-agent-events.jsonl'), `${JSON.stringify({
      version: 1,
      id: 'human-wait:e1',
      projectId: project.id,
      type: 'NEEDS_HUMAN',
      createdAt: '2026-09-18T00:00:00.000Z',
      payload: { phase: 'PLAN_REVIEW' },
      delivery: 'PENDING',
    })}\n`);
    manager.setDesiredState(project.id, 'RUNNING');
    let starts = 0;

    const supervisor = new AriadSupervisor({
      manager,
      reconcileIntervalMs: 60_000,
      createController: () => ({
        active: false,
        phase: 'NEEDS_HUMAN',
        async start() { starts += 1; },
        async stop() {},
        status() { return { active: this.active, phase: this.phase }; },
      }),
    });

    await supervisor.start();
    assert.equal(starts, 1);
    assert.equal(supervisor.status(project.id).executionState, 'NEEDS_HUMAN');
    await supervisor.reconcile();
    assert.equal(supervisor.status(project.id).controller, null);
    await supervisor.stop();

    const reopenedManager = new AriadProjectManager({ projectsRoot: dir });
    const restarted = new AriadSupervisor({
      manager: reopenedManager,
      reconcileIntervalMs: 60_000,
      createController: () => ({
        active: true,
        phase: 'RUNNING',
        async start() { starts += 1; },
        async stop() { this.active = false; },
        status() { return { active: this.active, phase: this.phase }; },
      }),
    });

    await restarted.start();
    assert.equal(starts, 1, 'NEEDS_HUMAN must not auto-rerun after restart');

    const response = await restarted.submitDecision(project.id, 'Proceed with the reviewed plan.');
    assert.equal(response.project.executionState, 'IDLE');
    assert.equal(starts, 1, 'decide RPC must not start a controller inline');

    await restarted.reconcile();
    assert.equal(starts, 2);
    assert.equal(restarted.status(project.id).executionState, 'RUNNING');
    await restarted.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing project manifests without executionState remain readable as IDLE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-project-state-compat-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const project = manager.create('legacy');
    const manifestPath = join(project.root, 'project.json');
    const legacy = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete legacy.executionState;
    writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);
    assert.equal(manager.status(project.id).executionState, 'IDLE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
