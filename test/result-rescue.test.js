import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAgentSessionProvider } from '../src/runtime/pi-agent-session-provider.js';

// Fake run whose session ends its first turn WITHOUT submitting, to
// exercise the provider-side rescue: the same session is prompted once
// more to submit its completed result.
async function execute({ submitOnRescue = true, providerError = false, submitImmediately = false } = {}) {
  const prompts = [];
  let sessions = 0;
  const provider = new PiAgentSessionProvider({
    createRunSession: async () => {
      sessions += 1;
      const session = {
        messages: [],
        async prompt(message) {
          prompts.push(message);
          if (providerError) {
            this.messages.push({ role: 'assistant', stopReason: 'error', errorMessage: 'boom' });
          } else {
            this.messages.push({ role: 'assistant', stopReason: 'stop' });
          }
        },
        dispose() {},
      };
      return {
        session,
        getTerminalResult: () => {
          if (providerError) return null;
          if (submitImmediately) return { outcome: 'PASS', summary: 'on time', keyPoints: [] };
          if (submitOnRescue && prompts.length >= 2) return { outcome: 'PASS', summary: 'rescued', keyPoints: [] };
          return null;
        },
      };
    },
  });
  const handle = await provider.start({
    projectId: 'P', taskId: 'T', role: 'developer', attemptId: 'P:T:1',
    sessionPolicy: 'fresh', context: { role: 'developer', roleModelRef: 'llamacpp/qwen3.8-27b' },
    prompt: 'Do the work',
  });
  await provider.runs.get(handle.externalId).promise;
  const state = await provider.poll(handle);
  await provider.close();
  return { prompts, sessions, state };
}

test('a session that ends without submitting is prompted once in the same session to submit', async () => {
  const r = await execute();
  assert.equal(r.state.state, 'COMPLETED');
  assert.equal(r.state.summary, 'rescued');
  assert.equal(r.sessions, 1, 'rescue reuses the same session, no new run session');
  assert.equal(r.prompts.length, 2, 'exactly one rescue prompt');
  assert.match(r.prompts[1], /without submitting your role result/);
  assert.ok(r.state.keyPoints.some(x => x.includes('ARIAD_RESULT_RECOVERED')));
});

test('a session that still does not submit after the rescue fails the attempt', async () => {
  const r = await execute({ submitOnRescue: false });
  assert.equal(r.state.state, 'FAILED');
  assert.match(r.state.failure, /ARIAD_ROLE_RESULT_MISSING/);
  assert.equal(r.prompts.length, 2, 'one rescue attempt, no loop');
});

test('a provider-error ending is not rescued', async () => {
  const r = await execute({ providerError: true });
  assert.equal(r.state.state, 'FAILED');
  assert.match(r.state.failure, /PI_PROVIDER_ERROR/);
  assert.equal(r.prompts.length, 1, 'no rescue prompt after a provider error');
});

test('an on-time submission needs no rescue and carries no marker', async () => {
  const r = await execute({ submitImmediately: true });
  assert.equal(r.state.state, 'COMPLETED');
  assert.equal(r.prompts.length, 1);
  assert.ok(!r.state.keyPoints.some(x => x.includes('ARIAD_RESULT_RECOVERED')));
});
