import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawProjectAgentAdapter } from '../dist/openclaw-project-agent-adapter.js';

function binding() {
  return {
    host: 'openclaw',
    agentId: 'main',
    sessionKey: 'agent:main:discord:channel:1548769611409793074',
  };
}

function event(type = 'NEEDS_HUMAN') {
  return {
    version: 1,
    id: 'frontdesk:srpg:NEEDS_HUMAN:1',
    projectId: 'srpg',
    type,
    createdAt: '2026-09-30T00:00:00.000Z',
    payload: {
      executionState: 'NEEDS_HUMAN',
      desiredState: 'RUNNING',
    },
  };
}

test('Frontdesk notification reuses bound session and sends through canonical channel route', async () => {
  const runs = [];
  const sends = [];
  const gateway = {
    request() {
      throw new Error('privileged Gateway RPC must never be used');
    },
  };
  const agent = {
    session: {
      getSessionEntry(input) {
        assert.deepEqual(input, {
          agentId: 'main',
          sessionKey: 'agent:main:discord:channel:1548769611409793074',
          readConsistency: 'latest',
        });
        return {
          sessionId: 'frontdesk-session-id',
          modelProvider: 'fakea',
          model: 'default',
          delivery: {
            kind: 'external',
            route: {
              channel: 'discord',
              accountId: 'default',
              target: { to: '1548769611409793074', chatType: 'channel' },
              thread: { id: 'thread-7', kind: 'thread' },
            },
            context: {
              channel: 'discord',
              to: 'legacy-target-must-not-win',
              accountId: 'legacy-account',
            },
            origin: {},
          },
        };
      },
    },
    resolveAgentWorkspaceDir: () => '/workspace',
    resolveAgentDir: () => '/agent',
    resolveAgentTimeoutMs: () => 4321,
    async runEmbeddedAgent(input) {
      runs.push(input);
      return { terminalReply: 'Please choose the recovery direction.' };
    },
  };
  const channel = {
    outbound: {
      async loadAdapter(channelId) {
        assert.equal(channelId, 'discord');
        return {
          async sendText(input) {
            sends.push(input);
            return { messageId: 'discord-message-1' };
          },
        };
      },
    },
  };

  const adapter = new OpenClawProjectAgentAdapter({
    agent,
    channel,
    config: () => ({ marker: 'cfg' }),
    agentId: 'main',
    gateway,
  });

  const result = await adapter.notify({ binding: binding(), event: event() });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].sessionId, 'frontdesk-session-id');
  assert.equal(runs[0].sessionKey, binding().sessionKey);
  assert.equal(runs[0].agentId, 'main');
  assert.equal(runs[0].workspaceDir, '/workspace');
  assert.equal(runs[0].agentDir, '/agent');
  assert.equal(runs[0].provider, 'fakea');
  assert.equal(runs[0].model, 'default');
  assert.equal(runs[0].timeoutMs, 4321);
  assert.match(runs[0].prompt, /Ariad needs a user decision/);
  assert.match(runs[0].prompt, /ariad_project action="decide"/);

  assert.deepEqual(sends, [{
    cfg: { marker: 'cfg' },
    to: '1548769611409793074',
    text: 'Please choose the recovery direction.',
    accountId: 'default',
    threadId: 'thread-7',
  }]);
  assert.equal(result.delivered, true);
  assert.equal(result.channel, 'discord');
  assert.equal(result.to, '1548769611409793074');
});

test('Frontdesk notification refuses to infer a channel target from the session key', async () => {
  const agent = {
    session: {
      getSessionEntry() {
        return {
          sessionId: 'frontdesk-session-id',
          delivery: { kind: 'internal' },
        };
      },
    },
    async runEmbeddedAgent() {
      throw new Error('must not run without an external delivery route');
    },
  };
  const channel = {
    outbound: {
      async loadAdapter() {
        throw new Error('must not load without an external delivery route');
      },
    },
  };
  const adapter = new OpenClawProjectAgentAdapter({
    agent,
    channel,
    config: () => ({}),
  });

  await assert.rejects(
    () => adapter.notify({ binding: binding(), event: event() }),
    /no external delivery route/
  );
});

test('Frontdesk notification fails closed when the channel cannot directly send text', async () => {
  const agent = {
    session: {
      getSessionEntry() {
        return {
          sessionId: 'frontdesk-session-id',
          delivery: {
            kind: 'external',
            route: { channel: 'discord', target: { to: '1548769611409793074' } },
            context: { channel: 'discord', to: '1548769611409793074' },
            origin: {},
          },
        };
      },
    },
    async runEmbeddedAgent() {
      return { terminalReply: 'Need a decision.' };
    },
  };
  const channel = {
    outbound: {
      async loadAdapter() {
        return { deliveryMode: 'gateway' };
      },
    },
  };
  const adapter = new OpenClawProjectAgentAdapter({
    agent,
    channel,
    config: () => ({}),
  });

  await assert.rejects(
    () => adapter.notify({ binding: binding(), event: event() }),
    /has no direct text outbound adapter/
  );
});
