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
      humanDecisions: [{
        taskId: 'v2-entry-lifecycle-gap',
        stage: 'project_debugger',
        summary: 'Debugger cannot choose safely.',
        questions: ['Should Ariad preserve the old save format or migrate it?'],
        outcome: 'UNKNOWN_PROJECT_CAUSE',
      }],
    },
  };
}

test('NEEDS_HUMAN notification bypasses embedded agent and sends deterministic text through canonical channel route', async () => {
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

  const inspection = await adapter.inspectBinding({ binding: binding() });
  assert.equal(inspection.deliverable, true);
  assert.deepEqual(inspection.delivery, {
    channel: 'discord',
    to: '1548769611409793074',
    accountId: 'default',
    threadId: 'thread-7',
  });

  const result = await adapter.notify({ binding: binding(), event: event() });

  assert.equal(runs.length, 0, 'human-decision alert must not depend on an embedded agent run');
  assert.equal(sends.length, 1);
  assert.deepEqual({
    cfg: sends[0].cfg,
    to: sends[0].to,
    accountId: sends[0].accountId,
    threadId: sends[0].threadId,
  }, {
    cfg: { marker: 'cfg' },
    to: '1548769611409793074',
    accountId: 'default',
    threadId: 'thread-7',
  });
  assert.match(sends[0].text, /Ariad needs your decision for srpg/);
  assert.match(sends[0].text, /Task: v2-entry-lifecycle-gap/);
  assert.match(sends[0].text, /Role: project_debugger/);
  assert.match(sends[0].text, /Reason: UNKNOWN_PROJECT_CAUSE/);
  assert.match(sends[0].text, /preserve the old save format or migrate it/);
  assert.equal(result.delivered, true);
  assert.equal(result.channel, 'discord');
  assert.equal(result.to, '1548769611409793074');
  assert.equal(result.renderedBy, 'deterministic-fallback');
  assert.equal(result.renderError, null);
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


test('Frontdesk binding inspection reports an undeliverable internal session', async () => {
  const adapter = new OpenClawProjectAgentAdapter({
    agent: {
      session: {
        getSessionEntry() {
          return { sessionId: 'internal-only', delivery: { kind: 'internal' } };
        },
      },
      async runEmbeddedAgent() {
        throw new Error('not used');
      },
    },
    channel: {
      outbound: {
        async loadAdapter() {
          throw new Error('not used');
        },
      },
    },
    config: () => ({}),
  });

  const inspection = await adapter.inspectBinding({ binding: binding() });
  assert.equal(inspection.deliverable, false);
  assert.equal(inspection.sessionKey, binding().sessionKey);
  assert.match(inspection.error, /no external delivery route/);
});


test('non-human Frontdesk event falls back deterministically when embedded agent returns no text', async () => {
  const sends = [];
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
    resolveAgentWorkspaceDir: () => '/workspace',
    async runEmbeddedAgent() {
      return { terminalReply: '' };
    },
  };
  const channel = {
    outbound: {
      async loadAdapter() {
        return {
          async sendText(input) {
            sends.push(input);
            return { messageId: 'fallback-message' };
          },
        };
      },
    },
  };
  const adapter = new OpenClawProjectAgentAdapter({
    agent,
    channel,
    config: () => ({}),
  });

  const result = await adapter.notify({
    binding: binding(),
    event: event('FAILED'),
  });

  assert.equal(result.delivered, true);
  assert.equal(result.renderedBy, 'deterministic-fallback');
  assert.match(result.renderError, /no deliverable reply/);
  assert.match(sends[0].text, /Ariad project srpg failed/);
});

test('non-human Frontdesk event falls back deterministically when embedded agent throws', async () => {
  const sends = [];
  const adapter = new OpenClawProjectAgentAdapter({
    agent: {
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
        throw new Error('utility model unavailable');
      },
    },
    channel: {
      outbound: {
        async loadAdapter() {
          return {
            async sendText(input) {
              sends.push(input);
              return { messageId: 'fallback-message-2' };
            },
          };
        },
      },
    },
    config: () => ({}),
  });

  const result = await adapter.notify({
    binding: binding(),
    event: event('SUCCEEDED'),
  });

  assert.equal(result.delivered, true);
  assert.equal(result.renderedBy, 'deterministic-fallback');
  assert.equal(result.renderError, 'utility model unavailable');
  assert.match(sends[0].text, /completed successfully/);
});
