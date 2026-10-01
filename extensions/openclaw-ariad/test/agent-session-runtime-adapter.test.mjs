import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawAgentSessionRuntimeAdapter } from '../dist/openclaw-agent-session-runtime-adapter.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('result recovery reuses the same normal agent session and only asks for structured result', async () => {
  const calls = [];
  const pending = [];
  const agent = {
    session: { getSessionEntry: () => null },
    resolveAgentWorkspaceDir: () => '/workspace',
    resolveAgentDir: () => '/agent',
    resolveAgentTimeoutMs: () => 1234,
    runEmbeddedAgent(input) {
      calls.push(input);
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
  };

  const adapter = new OpenClawAgentSessionRuntimeAdapter({
    agent,
    config: () => ({}),
    pluginId: 'ariad',
    agentId: 'main',
    renderMessage: () => 'do role work',
  });

  const handle = await adapter.start({
    runId: 'attempt-1',
    role: 'developer',
    context: {
      projectId: 'p',
      taskId: 't',
      attemptId: 'attempt-1',
      provider: 'fake',
      model: 'role',
      resultToolName: 'ariad_developer_result',
      workspace: '/workspace',
    },
  });

  pending[0].resolve({ terminalReply: 'finished without structured result' });
  await Promise.resolve();
  await Promise.resolve();

  const recovering = await adapter.recoverRoleResult(handle, { attemptId: 'attempt-1', role: 'developer' });
  assert.equal(recovering.state, 'RUNNING');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionKey, calls[0].sessionKey);
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.deepEqual(calls[1].runtimePluginToolGrant, {
    pluginId: 'ariad',
    toolNames: ['ariad_developer_result'],
  });
  assert.match(calls[1].prompt, /Do not redo the task/);
  assert.match(calls[1].prompt, /attempt-1/);

  const terminated = await adapter.terminateAttempt('attempt-1');
  assert.equal(terminated.requested, true);
  assert.equal(typeof terminated.recoveryExternalId, 'string');
  assert.equal(calls[1].abortSignal.aborted, true);

  pending[1].reject(calls[1].abortSignal.reason);
  await Promise.resolve();
  await Promise.resolve();

  const completed = await adapter.recoverRoleResult(handle, { attemptId: 'attempt-1', role: 'developer' });
  assert.equal(completed.state, 'COMPLETED');
});

test('persistent role policy reuses the same session key across attempts', async () => {
  const calls = [];
  const agent = {
    session: { getSessionEntry: () => null },
    resolveAgentWorkspaceDir: () => '/workspace',
    runEmbeddedAgent(input) {
      calls.push(input);
      return new Promise(() => {});
    },
  };
  const adapter = new OpenClawAgentSessionRuntimeAdapter({
    agent,
    config: () => ({}),
    agentId: 'main',
  });

  await adapter.start({
    runId: 'a1',
    role: 'pm',
    context: { projectId: 'p', taskId: 't1', attemptId: 'a1', sessionPolicy: 'persistent' },
  });
  await adapter.start({
    runId: 'a2',
    role: 'pm',
    context: { projectId: 'p', taskId: 't2', attemptId: 'a2', sessionPolicy: 'persistent' },
  });

  assert.equal(calls[0].sessionKey, calls[1].sessionKey);
  assert.match(calls[0].sessionKey, /persistent-p-pm$/);
});


test('missing in-memory run handle is reported as a non-consuming restart orphan', async () => {
  const agent = {
    session: { getSessionEntry: () => null },
    resolveAgentWorkspaceDir: () => '/workspace',
    runEmbeddedAgent() {
      return new Promise(() => {});
    },
  };
  const adapter = new OpenClawAgentSessionRuntimeAdapter({
    agent,
    config: () => ({}),
    agentId: 'main',
  });

  const status = await adapter.poll({ externalId: 'lost-after-gateway-restart' });
  assert.deepEqual(status, {
    state: 'LOST',
    failure: 'AGENT_SESSION_RUN_NOT_FOUND',
    consumeAttempt: false,
    restartOrphan: true,
  });
});
