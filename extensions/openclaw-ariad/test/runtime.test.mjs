import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawRuntimeAdapter } from '../dist/openclaw-runtime-adapter.js';
import { OpenClawProjectAgentAdapter } from '../dist/openclaw-project-agent-adapter.js';
import { AriadSupervisor } from '../dist/ariad-supervisor.js';
import { AriadProjectManager } from '../runtime/project-manager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.match(calls[0].params.message, /Choose A or B/);
  assert.equal(calls[0].options.timeoutMs, 35_000);
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
