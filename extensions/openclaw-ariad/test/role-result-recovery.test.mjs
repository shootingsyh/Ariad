import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawRuntimeAdapter } from '../dist/openclaw-runtime-adapter.js';

test('OpenClawRuntimeAdapter recovers a missing result submission in the original session exactly once', async () => {
  const runs = [];
  let recoveryPolls = 0;
  const subagent = {
    async run(input) {
      runs.push(input);
      if (runs.length === 1) {
        return {
          runId: 'role-run',
          sessionKey: input.sessionKey,
          runtime: { harness: 'openclaw', provider: 'muse', model: 'spark' },
        };
      }
      return { runId: 'recovery-run', sessionKey: input.sessionKey };
    },
    async waitForRun({ runId }) {
      assert.equal(runId, 'recovery-run');
      recoveryPolls += 1;
      return recoveryPolls === 1
        ? { status: 'timeout' }
        : { status: 'ok', terminalReply: { text: 'submitted' } };
    },
  };

  const adapter = new OpenClawRuntimeAdapter({ subagent, pollTimeoutMs: 1 });
  const handle = await adapter.start({
    runId: 'ariad-run',
    role: 'artist',
    context: {
      projectId: 'p1',
      taskId: 'art-1',
      attemptId: 'p1:art-1:artist:1',
      resultToolName: 'ariad_artist_result',
    },
  });

  const first = await adapter.recoverRoleResult(handle, {
    attemptId: 'p1:art-1:artist:1',
    role: 'artist',
  });
  assert.equal(first.state, 'RUNNING');
  assert.equal(runs.length, 2);
  assert.equal(runs[1].sessionKey, runs[0].sessionKey);
  assert.deepEqual(runs[1].toolsAlsoAllow, ['ariad_artist_result']);
  assert.match(runs[1].message, /Do not redo the work/);
  assert.match(runs[1].message, /p1:art-1:artist:1/);

  const second = await adapter.recoverRoleResult(handle, {
    attemptId: 'p1:art-1:artist:1',
    role: 'artist',
  });
  assert.equal(second.state, 'COMPLETED');
  assert.equal(runs.length, 2, 'recovery must reuse the same recovery run across audits');
});

test('OpenClawRuntimeAdapter refuses result recovery for the wrong attempt or role', async () => {
  const adapter = new OpenClawRuntimeAdapter({
    subagent: {
      async run(input) { return { runId: 'role-run', sessionKey: input.sessionKey }; },
      async waitForRun() { return { status: 'ok' }; },
    },
  });
  const handle = await adapter.start({
    runId: 'ariad-run',
    role: 'artist',
    context: {
      projectId: 'p1',
      taskId: 'art-1',
      attemptId: 'attempt-1',
      resultToolName: 'ariad_artist_result',
    },
  });

  assert.deepEqual(
    await adapter.recoverRoleResult(handle, { attemptId: 'attempt-2', role: 'artist' }),
    { state: 'FAILED', failure: 'ROLE_RESULT_RECOVERY_BINDING_MISMATCH' },
  );
  assert.deepEqual(
    await adapter.recoverRoleResult(handle, { attemptId: 'attempt-1', role: 'developer' }),
    { state: 'FAILED', failure: 'ROLE_RESULT_RECOVERY_BINDING_MISMATCH' },
  );
});
