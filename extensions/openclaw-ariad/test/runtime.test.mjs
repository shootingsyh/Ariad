import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawRuntimeAdapter } from '../dist/openclaw-runtime-adapter.js';
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

  const handle = await adapter.start({ runId: 'ariad-run-1', role: 'reviewer', context: { taskId: 'T1' } });
  assert.equal(handle.externalId, 'oc-run-1');
  assert.equal(calls[0][1].sessionKey, 'agent:worker:subagent:ariad-ariad-run-1');
  assert.equal(calls[0][1].provider, 'fake');
  assert.equal(calls[0][1].model, 'role-model');
  assert.equal(calls[0][1].deliver, false);
  assert.equal(calls[0][1].message, 'ROLE=reviewer;TASK=T1');

  const result = await adapter.poll(handle);
  assert.deepEqual(result, { state: 'COMPLETED', outcome: 'PASS', result: { ok: true } });
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

test('AriadSupervisor reconciles durable desired RUNNING projects after host restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-supervisor-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    manager.create('alpha');
    manager.create('beta');
    manager.setDesiredState('alpha', 'RUNNING');
    const events = [];
    const supervisor = new AriadSupervisor({
      manager,
      createController: (project) => ({
        async start() { events.push(`start:${project.id}`); },
        async stop() { events.push(`stop:${project.id}`); },
      }),
    });

    await supervisor.start();
    assert.equal(supervisor.status('alpha').active, true);
    assert.equal(supervisor.status('beta').active, false);
    await supervisor.ensureRunning('beta');
    await supervisor.ensureStopped('alpha');
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
