import test from 'node:test';
import assert from 'node:assert/strict';

import { maybeCompactPersistentSessionBeforeRun, maybeCompactPmSessionBeforeRun, sessionCompactRatio, pmSessionCompactRatio, SESSION_COMPACT_RATIO, PM_SESSION_COMPACT_RATIO } from '../src/runtime/pi-agent-session-provider.js';
const maybeCompactPmSessionBeforeRunUnderTest = maybeCompactPersistentSessionBeforeRun;

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

test('unguarded roles never compact through this guard', async () => {
  const session = fakeSession({ tokens: 990 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, { role: 'tech_lead', sessionPolicy: 'persistent' }), false);
  assert.equal(await maybeCompactPmSessionBeforeRun(session, { role: 'developer', sessionPolicy: 'persistent' }), false);
  assert.equal(session.state.compactCalls, 0);
});

test('project_debugger persistent session over 70% compacts before the run', async () => {
  const session = fakeSession({ tokens: 850 });
  const spec = { role: 'project_debugger', sessionPolicy: 'persistent', projectId: 'P1', taskId: 'T9' };
  assert.equal(await maybeCompactPmSessionBeforeRun(session, spec), true);
  assert.equal(session.state.compactCalls, 1);
});

test('project_debugger persistent session under threshold does not compact', async () => {
  const session = fakeSession({ tokens: 400 });
  const spec = { role: 'project_debugger', sessionPolicy: 'persistent', projectId: 'P1', taskId: 'T9' };
  assert.equal(await maybeCompactPmSessionBeforeRun(session, spec), false);
  assert.equal(session.state.compactCalls, 0);
});

test('legacy pm-named exports remain aliases of the generalized guard', () => {
  assert.equal(maybeCompactPmSessionBeforeRun, maybeCompactPmSessionBeforeRunUnderTest);
  assert.equal(pmSessionCompactRatio, sessionCompactRatio);
  assert.equal(PM_SESSION_COMPACT_RATIO, SESSION_COMPACT_RATIO);
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

test('ratio honours ARIAD_SESSION_COMPACT_RATIO / legacy ARIAD_PM_COMPACT_RATIO and falls back to 0.7', () => {
  assert.equal(SESSION_COMPACT_RATIO, 0.7);
  assert.equal(sessionCompactRatio({}), 0.7);
  assert.equal(sessionCompactRatio({ ARIAD_SESSION_COMPACT_RATIO: '0.5' }), 0.5);
  assert.equal(sessionCompactRatio({ ARIAD_PM_COMPACT_RATIO: '0.6' }), 0.6);
  assert.equal(sessionCompactRatio({ ARIAD_SESSION_COMPACT_RATIO: '0.5', ARIAD_PM_COMPACT_RATIO: '0.6' }), 0.5);
  assert.equal(sessionCompactRatio({ ARIAD_SESSION_COMPACT_RATIO: '2' }), 0.7);
  assert.equal(sessionCompactRatio({ ARIAD_SESSION_COMPACT_RATIO: 'abc' }), 0.7);
});

test('custom ratio option is honoured', async () => {
  const session = fakeSession({ tokens: 600 });
  assert.equal(await maybeCompactPmSessionBeforeRun(session, pmSpec, { ratio: 0.5 }), true);
  assert.equal(session.state.compactCalls, 1);
});
