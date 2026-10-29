import test from 'node:test';
import assert from 'node:assert/strict';

import { attemptIgnition, detectIgnitionCandidates, FREE_CLOUD_HINTS } from '../src/runtime/bootstrap.js';

function fakeService(overrides = {}) {
  const calls = { upserts: [], tested: [] };
  const service = {
    configuredProviders: () => [],
    listProviderModels: async () => [],
    probeLocalEndpoint: async () => ({ reachable: false, status: null, error: 'connect ECONNREFUSED', models: [] }),
    upsertCustomProvider: (id, entry) => { calls.upserts.push({ id, entry }); return { saved: true }; },
    testModelRef: async ref => { calls.tested.push(ref); return { ok: true }; },
    ...overrides,
  };
  return { service, calls };
}

test('ignition: cheapest existing model answers on the first rung', async () => {
  const { service, calls } = fakeService({
    configuredProviders: () => [{ id: 'anthropic', source: 'pi-auth' }],
    listProviderModels: async () => ([
      { id: 'opus', cost: { input: 15, output: 75 } },
      { id: 'haiku', cost: { input: 1, output: 5 } },
    ]),
  });
  const result = await attemptIgnition({ configService: service, localBaseUrl: null });
  assert.equal(result.ignited.ref, 'anthropic/haiku', 'cheapest model is the igniter');
  assert.equal(result.ignited.kind, 'existing');
  assert.deepEqual(calls.tested, ['anthropic/haiku']);
});

test('ignition: a dead first rung falls through to the local endpoint', async () => {
  const { service, calls } = fakeService({
    configuredProviders: () => [{ id: 'anthropic', source: 'pi-auth' }],
    listProviderModels: async () => [{ id: 'haiku', cost: { input: 1, output: 5 } }],
    probeLocalEndpoint: async () => ({ reachable: true, status: 200, error: null, models: ['qwen3.8-27b'] }),
    testModelRef: async ref => (ref.startsWith('local/')
      ? { ok: true }
      : { ok: false, reason: 'quota exhausted' }),
  });
  const result = await attemptIgnition({ configService: service, localBaseUrl: 'http://127.0.0.1:18080/v1' });
  assert.equal(result.ignited.ref, 'local/qwen3.8-27b');
  assert.equal(result.attempts[0].ok, false);
  assert.match(result.attempts[0].reason, /quota/);
  assert.equal(calls.upserts[0].id, 'local', 'local endpoint registered before the test call');
  assert.deepEqual(calls.upserts[0].entry.models[0].id, 'qwen3.8-27b');
});

test('ignition failure is a structured report with a manual fallback, never an exception', async () => {
  const { service, calls } = fakeService({
    testModelRef: async () => ({ ok: false, reason: 'network unreachable' }),
  });
  const candidates = await detectIgnitionCandidates({ configService: service, localBaseUrl: 'http://127.0.0.1:18080/v1' });
  assert.equal(candidates.at(-1).kind, 'free-cloud');
  assert.equal(candidates.at(-1).provider, FREE_CLOUD_HINTS[0].provider);

  const result = await attemptIgnition({ configService: service, localBaseUrl: 'http://127.0.0.1:18080/v1' });
  assert.equal(result.ignited, null);
  assert.equal(result.fallback.mode, 'manual');
  assert.ok(result.fallback.nextActions.some(action => action.includes('Free key')));
  assert.ok(result.fallback.nextActions.some(action => action.includes('config guide')));
  assert.equal(result.attempts.length, 1, 'the unreachable local endpoint is recorded as an attempt');
  assert.match(result.attempts[0].reason, /unreachable/);
  assert.equal(calls.tested.length, 0, 'free-cloud candidates are never auto-attempted - they need a user-fetched key');
});
