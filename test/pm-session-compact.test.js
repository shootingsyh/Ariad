import test from 'node:test';
import assert from 'node:assert/strict';

import { maybeCompactPmSessionBeforeRun, pmSessionCompactRatio, PM_SESSION_COMPACT_RATIO } from '../src/runtime/pi-agent-session-provider.js';

function fakeSession({ tokens, contextWindow = 1000, compactError = null } = {}) {
  const state = { compactCalls: 0 };
  return {
    state,
    getContextUsage() {
      return tokens == null ? { tokens: null, contextWindow } : { tokens, contextWindow };
    },
    async compact() {
      state.compactCalls += 1;
      if (compactError) throw compactError;
    },
  };
}

const pmSpec = { role: 'pm', sessionPolicy: 'persistent', projectId: 'P1', taskId: 'T1' };

test('pm persistent session over 70% of the model window compacts before the run', async () => {
  const session = fakeSession({ tokens: 800 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, pmSpec), true);
  assert.equal(session.state.compactCalls, 1);
});

test('pm persistent session at exactly 70% does not compact (must exceed)', async () => {
  const session = fakeSession({ tokens: 700 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, pmSpec), false);
  assert.equal(session.state.compactCalls, 0);
});

test('pm persistent session under threshold does not compact', async () => {
  const session = fakeSession({ tokens: 300 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, pmSpec), false);
  assert.equal(session.state.compactCalls, 0);
});

test('non-pm roles never compact through this guard', async () => {
  const session = fakeSession({ tokens: 990 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, { role: 'tech_lead', sessionPolicy: 'persistent' }), false);
  assert.equal(session.state.compactCalls, 0);
});

test('fresh pm sessions do not compact through this guard', async () => {
  const session = fakeSession({ tokens: 990 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, { role: 'pm', sessionPolicy: 'fresh' }), false);
  assert.equal(session.state.compactCalls, 0);
});

test('unknown context usage skips compaction', async () => {
  const session = fakeSession({ tokens: null });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, pmSpec), false);
  assert.equal(session.state.compactCalls, 0);
});

test('a failing compaction returns false instead of throwing into the run', async () => {
  const session = fakeSession({ tokens: 900, compactError: new Error('boom') });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, pmSpec), false);
  assert.equal(session.state.compactCalls, 1);
});

test('ratio honours ARIAD_PM_COMPACT_RATIO and falls back to 0.7', () => {
  assert.equal(PM_SESSION_COMPACT_RATIO, 0.7);
  assert.equal(pmSessionCompactRatio({}), 0.7);
  assert.equal(pmSessionCompactRatio({ ARIAD_PM_COMPACT_RATIO: '0.5' }), 0.5);
  assert.equal(pmSessionCompactRatio({ ARIAD_PM_COMPACT_RATIO: '2' }), 0.7);
  assert.equal(pmSessionCompactRatio({ ARIAD_PM_COMPACT_RATIO: 'abc' }), 0.7);
});

test('custom ratio option is honoured', async () => {
  const session = fakeSession({ tokens: 600 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, pmSpec, { ratio: 0.5 }), true);
  assert.equal(session.state.compactCalls, 1);
});
