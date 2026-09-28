import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgentHostProvider } from '../src/v2/mock-agent-host-provider.js';

test('one agent host isolates concurrent sessions across roles and projects', async () => {
  const seen = [];
  const provider = new MockAgentHostProvider({
    id: 'ariad-worker',
    worker: async ({ hostAgentId, role, model, context, submitResult }) => {
      seen.push({ hostAgentId, role, model, marker: context.marker });
      await submitResult({
        outcome: 'PASS',
        summary: `finished ${context.marker}`,
        result: { marker: context.marker },
      });
    },
  });

  const dev = await provider.start({
    projectId: 'project-a', taskId: 'task-1', attemptId: 'a1', role: 'developer',
    model: 'local/qwen', context: { marker: 'DEV-A' },
  });
  const artist = await provider.start({
    projectId: 'project-b', taskId: 'task-9', attemptId: 'b3', role: 'artist',
    model: 'muse/spark', context: { marker: 'ART-B' },
  });
  const pm = await provider.start({
    projectId: 'project-a', taskId: 'project-lifecycle', attemptId: 'pm-1', role: 'pm',
    model: 'muse/main', context: { marker: 'PM-A' },
  });

  assert.notEqual(dev.sessionId, artist.sessionId);
  assert.notEqual(dev.sessionId, pm.sessionId);
  assert.match(dev.sessionId, /^ariad-worker-session-/);
  assert.match(artist.sessionId, /^ariad-worker-session-/);
  assert.match(pm.sessionId, /^ariad-worker-session-/);

  assert.deepEqual(seen, [
    { hostAgentId: 'ariad-worker', role: 'developer', model: 'local/qwen', marker: 'DEV-A' },
    { hostAgentId: 'ariad-worker', role: 'artist', model: 'muse/spark', marker: 'ART-B' },
    { hostAgentId: 'ariad-worker', role: 'pm', model: 'muse/main', marker: 'PM-A' },
  ]);

  assert.equal(provider.getBinding(dev.sessionId).hostAgentId, 'ariad-worker');
  assert.equal(provider.getBinding(dev.sessionId).role, 'developer');
  assert.equal(provider.getBinding(artist.sessionId).role, 'artist');
  assert.equal(provider.getBinding(pm.sessionId).role, 'pm');
  assert.equal(provider.getSession(dev.sessionId).model, 'local/qwen');
  assert.equal(provider.getSession(artist.sessionId).model, 'muse/spark');
  assert.equal(provider.getSession(pm.sessionId).model, 'muse/main');

  const dr = await provider.poll({ externalId: dev.sessionId });
  const ar = await provider.poll({ externalId: artist.sessionId });
  const pr = await provider.poll({ externalId: pm.sessionId });
  assert.equal(dr.result.marker, 'DEV-A');
  assert.equal(ar.result.marker, 'ART-B');
  assert.equal(pr.result.marker, 'PM-A');
  assert.equal(dr.binding.attemptId, 'a1');
  assert.equal(ar.binding.attemptId, 'b3');
  assert.equal(pr.binding.attemptId, 'pm-1');
});

test('result submission identity comes from host binding, not model payload', async () => {
  const provider = new MockAgentHostProvider({
    worker: async ({ submitResult }) => {
      await submitResult({
        outcome: 'PASS',
        summary: 'done',
        result: { attemptId: 'wrong-attempt', role: 'wrong-role', sessionId: 'wrong-session' },
      });
    },
  });

  const handle = await provider.start({
    projectId: 'p', taskId: 't', attemptId: 'trusted-attempt', role: 'developer',
  });
  const result = await provider.poll({ externalId: handle.externalId });
  assert.equal(result.binding.attemptId, 'trusted-attempt');
  assert.equal(result.binding.role, 'developer');
  assert.equal(result.binding.hostAgentId, 'ariad-worker');
  assert.equal(result.result.attemptId, 'wrong-attempt');
});
