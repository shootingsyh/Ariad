import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgentHostProvider } from '../src/v2/mock-agent-host-provider.js';

test('one role host can execute independent sessions across projects', async () => {
  const seen = [];
  const provider = new MockAgentHostProvider({
    worker: async ({ role, context, submitResult }) => {
      // The worker receives work data and a bound submit capability. It never
      // receives or echoes sessionId/projectId/taskId/attemptId as identity.
      seen.push({ role, marker: context.marker });
      await submitResult({
        outcome: 'PASS',
        summary: `finished ${context.marker}`,
        result: { marker: context.marker },
      });
    },
  });

  const a = await provider.start({
    projectId: 'project-a', taskId: 'task-1', attemptId: 'a1', role: 'artist',
    context: { marker: 'A' },
  });
  const b = await provider.start({
    projectId: 'project-b', taskId: 'task-9', attemptId: 'b3', role: 'artist',
    context: { marker: 'B' },
  });

  assert.notEqual(a.sessionId, b.sessionId);
  assert.deepEqual(seen, [
    { role: 'artist', marker: 'A' },
    { role: 'artist', marker: 'B' },
  ]);

  assert.deepEqual(provider.getBinding(a.sessionId), {
    sessionId: a.sessionId,
    projectId: 'project-a', taskId: 'task-1', attemptId: 'a1', role: 'artist',
  });
  assert.deepEqual(provider.getBinding(b.sessionId), {
    sessionId: b.sessionId,
    projectId: 'project-b', taskId: 'task-9', attemptId: 'b3', role: 'artist',
  });

  const ar = await provider.poll({ externalId: a.sessionId });
  const br = await provider.poll({ externalId: b.sessionId });
  assert.equal(ar.result.marker, 'A');
  assert.equal(br.result.marker, 'B');
  assert.equal(ar.binding.attemptId, 'a1');
  assert.equal(br.binding.attemptId, 'b3');
});

test('result submission identity comes from host binding, not model payload', async () => {
  const provider = new MockAgentHostProvider({
    worker: async ({ submitResult }) => {
      await submitResult({
        outcome: 'PASS',
        summary: 'done',
        // Deliberately hostile/incorrect identity-like fields are just result
        // payload data; they cannot alter the trusted session binding.
        result: { attemptId: 'wrong-attempt', role: 'wrong-role' },
      });
    },
  });

  const handle = await provider.start({
    projectId: 'p', taskId: 't', attemptId: 'trusted-attempt', role: 'developer',
  });
  const result = await provider.poll({ externalId: handle.externalId });
  assert.equal(result.binding.attemptId, 'trusted-attempt');
  assert.equal(result.binding.role, 'developer');
  assert.equal(result.result.attemptId, 'wrong-attempt');
});
