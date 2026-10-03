import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PydanticRuntimeClient, PydanticV2Provider } from '../src/runtime/pydantic-v2-provider.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForTerminal(provider, externalId) {
  let last = null;
  for (let i = 0; i < 200; i += 1) {
    last = await provider.poll({ externalId });
    if (!['RUNNING', 'QUEUED'].includes(last.state)) return last;
    await sleep(10);
  }
  throw new Error(`pydantic runtime did not settle; last=${JSON.stringify(last)}`);
}

test('standalone Pydantic provider runs a tool-capable structured role without OpenClaw', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pydantic-provider-'));
  fs.writeFileSync(path.join(workspace, 'health.txt'), 'status=healthy\n');
  const runtime = new PydanticRuntimeClient();
  const provider = new PydanticV2Provider(runtime, {
    resolveModelRef: () => 'test/runtime',
  });

  try {
    const handle = await provider.start({
      projectId: 'P1',
      taskId: 'T1',
      role: 'developer',
      attemptId: 'P1:T1:developer:1',
      workspace,
      prompt: 'Inspect the workspace, then return the required structured role result.',
      context: {},
    });
    assert.ok(handle.externalId);

    const status = await waitForTerminal(provider, handle.externalId);
    assert.equal(status.state, 'COMPLETED');
    assert.equal(status.outcome, 'PASS');
    assert.match(status.summary, /Pydantic runtime test completed/i);
    assert.deepEqual(status.keyPoints, ['pydantic-ai-agent-loop']);
    assert.deepEqual(status.result, { backend: 'test' });
  } finally {
    await provider.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('V2 scheduler and supervisor can use pydantic-v2 with provider-terminal completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pydantic-v2-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'input.txt'), 'hello\n');
  const store = new SQLiteV2Store(path.join(root, 'state.db'));
  const runtime = new PydanticRuntimeClient();
  const provider = new PydanticV2Provider(runtime, {
    resolveModelRef: () => 'test/runtime',
  });

  try {
    store.createProject({ id: 'P2', spec: 'standalone runtime' });
    store.createTask({ id: 'T2', projectId: 'P2', stage: 'developer' });

    const roles = new RoleRegistry();
    roles.register('developer', {
      prepare: () => ({
        provider: 'pydantic-v2',
        workspace,
        prompt: 'Inspect the workspace and complete the task.',
        completionProtocol: 'provider_terminal',
        context: { roleModelRef: 'test/runtime' },
      }),
      transition: ({ result }) => result.outcome === 'PASS'
        ? { stage: 'developer', state: 'DONE' }
        : { stage: 'developer', state: 'READY' },
    });

    const providers = new ProviderRegistry();
    providers.register(provider);
    const resources = new ResourcePool({});
    const scheduler = new V2Scheduler({ store, roles, providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });

    const started = await scheduler.tick('P2');
    assert.deepEqual(started.started, ['T2']);

    let task = store.getTask('T2');
    assert.equal(task.state, 'WORKING');
    assert.equal(task.execution.provider, 'pydantic-v2');
    assert.equal(task.execution.completionProtocol, 'provider_terminal');

    for (let i = 0; i < 200 && task.state === 'WORKING'; i += 1) {
      await supervisor.audit('P2');
      task = store.getTask('T2');
      if (task.state === 'WORKING') await sleep(10);
    }
    assert.equal(task.state, 'RESULT_READY');

    await scheduler.tick('P2');
    task = store.getTask('T2');
    assert.equal(task.state, 'DONE');
    const result = task.history.find(entry => entry.type === 'ROLE_RESULT');
    assert.equal(result?.outcome, 'PASS');
    assert.equal(result?.source, undefined);
    assert.match(result?.summary ?? '', /Pydantic runtime test completed/i);
  } finally {
    await provider.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('empty model output is retried once instead of being treated as completion', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pydantic-empty-'));
  const runtime = new PydanticRuntimeClient();
  const provider = new PydanticV2Provider(runtime, {
    resolveModelRef: () => 'test/empty-once',
    resolveModelConfig: () => ({ kind: 'test', model: 'empty-once', scenario: 'empty-once' }),
  });

  try {
    const handle = await provider.start({
      projectId: 'P-empty',
      taskId: 'T-empty',
      role: 'developer',
      workspace,
      prompt: 'Complete the task and return RoleResult.',
      context: {},
    });
    const status = await waitForTerminal(provider, handle.externalId);
    assert.equal(status.state, 'COMPLETED');
    assert.equal(status.outcome, 'PASS');
    assert.equal(status.debug?.modelCalls, 2);
    assert.match(status.debug?.lastModelAction ?? '', /^output:/);
  } finally {
    await provider.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('repeated empty model output fails protocol instead of completing', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pydantic-empty-fail-'));
  const runtime = new PydanticRuntimeClient();
  const provider = new PydanticV2Provider(runtime, {
    resolveModelRef: () => 'test/empty-always',
    resolveModelConfig: () => ({ kind: 'test', model: 'empty-always', scenario: 'empty-always' }),
  });

  try {
    const handle = await provider.start({
      projectId: 'P-empty-fail',
      taskId: 'T-empty-fail',
      role: 'developer',
      workspace,
      prompt: 'Complete the task and return RoleResult.',
      context: {},
    });
    const status = await waitForTerminal(provider, handle.externalId);
    assert.equal(status.state, 'FAILED');
    assert.match(status.failure ?? '', /UnexpectedModelBehavior|retry|output/i);
    assert.ok((status.debug?.modelCalls ?? 0) >= 2);
  } finally {
    await provider.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('idle watchdog cancels a stalled role run', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pydantic-idle-'));
  const runtime = new PydanticRuntimeClient();
  const provider = new PydanticV2Provider(runtime, {
    resolveModelRef: () => 'test/stall',
    resolveModelConfig: () => ({ kind: 'test', model: 'stall', scenario: 'stall', stallSeconds: 1 }),
  });

  try {
    const handle = await provider.start({
      projectId: 'P-idle',
      taskId: 'T-idle',
      role: 'developer',
      workspace,
      prompt: 'Do not hang.',
      context: {},
      runtimePolicy: { idleTimeoutSeconds: 0.1 },
    });
    const status = await waitForTerminal(provider, handle.externalId);
    assert.equal(status.state, 'FAILED');
    assert.match(status.failure ?? '', /IDLE_TIMEOUT/i);
  } finally {
    await provider.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});


test('persistent roles reload Ariad-owned message history across runs', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pydantic-memory-'));
  const runtime = new PydanticRuntimeClient();
  const provider = new PydanticV2Provider(runtime, {
    resolveModelRef: () => 'test/runtime',
  });

  try {
    const first = await provider.start({
      projectId: 'P-memory',
      taskId: 'PM-1',
      role: 'pm',
      attemptId: 'P-memory:PM-1:pm:1',
      workspace,
      prompt: 'Remember this first project interaction.',
      sessionPolicy: 'persistent',
      sessionKey: 'pm:P-memory',
      context: {},
    });
    const firstStatus = await waitForTerminal(provider, first.externalId);
    assert.equal(firstStatus.state, 'COMPLETED');
    assert.equal(firstStatus.debug?.historyMessages, 0);

    const second = await provider.start({
      projectId: 'P-memory',
      taskId: 'PM-2',
      role: 'pm',
      attemptId: 'P-memory:PM-2:pm:1',
      workspace,
      prompt: 'Continue from the prior project interaction.',
      sessionPolicy: 'persistent',
      sessionKey: 'pm:P-memory',
      context: {},
    });
    const secondStatus = await waitForTerminal(provider, second.externalId);
    assert.equal(secondStatus.state, 'COMPLETED');
    assert.ok((secondStatus.debug?.historyMessages ?? 0) > 0);

    const memoryDir = path.join(workspace, '.ariad', 'memory', 'sessions');
    assert.equal(fs.readdirSync(memoryDir).filter(name => name.endsWith('.json')).length, 1);
  } finally {
    await provider.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
