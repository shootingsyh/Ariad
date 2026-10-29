import test from 'node:test';
import assert from 'node:assert/strict';

import { runConfigWizard } from '../src/runtime/config-wizard.js';

const ANTHROPIC_MODELS = [
  { id: 'claude-flagship', contextWindow: 200000, maxTokens: 64000, cost: { input: 15, output: 75 } },
  { id: 'claude-mid', contextWindow: 200000, maxTokens: 64000, cost: { input: 3, output: 15 } },
  { id: 'claude-cheap', contextWindow: 200000, maxTokens: 8192, cost: { input: 1, output: 5 } },
];

function scriptedIo(script) {
  const queues = {
    choose: [...(script.choose ?? [])],
    input: [...(script.input ?? [])],
    secret: [...(script.secret ?? [])],
    confirm: [...(script.confirm ?? [])],
  };
  const lines = [];
  return {
    lines,
    print: line => lines.push(String(line)),
    choose: async (title, options) => {
      assert.ok(queues.choose.length, `unscripted choose: ${title}`);
      const index = queues.choose.shift();
      assert.ok(index >= 0 && index < options.length, `choose index ${index} out of range for: ${title}`);
      return index;
    },
    input: async (prompt, { default: def } = {}) => {
      const value = queues.input.length ? queues.input.shift() : '';
      return value || def || '';
    },
    secret: async () => (queues.secret.length ? queues.secret.shift() : ''),
    confirm: async () => (queues.confirm.length ? queues.confirm.shift() : false),
  };
}

function fakeService(overrides = {}) {
  const calls = { saveApiKey: [], upsertCustomProvider: [], setRoleDefaults: [] };
  const service = {
    calls,
    readiness: () => ({ providers: {} }),
    configuredProviders: () => [],
    customProviders: () => [],
    roleDefaults: () => null,
    saveApiKey: (providerId, key) => { calls.saveApiKey.push({ providerId, key }); return { saved: true, providerId }; },
    probeLocalEndpoint: async baseUrl => ({ baseUrl, reachable: true, models: ['qwen-local'] }),
    upsertCustomProvider: (id, provider) => { calls.upsertCustomProvider.push({ id, provider }); return { saved: true }; },
    listProviderModels: async providerId => (providerId === 'anthropic' ? ANTHROPIC_MODELS : []),
    validateRoleModels: async roleModels => ({
      complete: true,
      completenessError: null,
      roles: Object.fromEntries(Object.entries(roleModels).map(([role, ref]) => [role, { ref, ok: true, cost: { input: 1, output: 1 } }])),
    }),
    testModelRef: async ref => ({ ref, ok: true }),
    setRoleDefaults: roleModels => { calls.setRoleDefaults.push(roleModels); return roleModels; },
    ...overrides,
  };
  return service;
}

test('wizard: API key route + quality preset saves tiered role defaults', async () => {
  const service = fakeService();
  const io = scriptedIo({
    choose: [0, 1, 0, 0], // access menu: key -> provider: anthropic -> access menu: done -> strategy: quality
    secret: ['sk-ant-test'],
    confirm: [false], // no live test call
  });
  const result = await runConfigWizard({ service, io, localBaseUrlDefault: 'http://127.0.0.1:9/v1' });
  assert.equal(result.saved, true);
  assert.deepEqual(service.calls.saveApiKey, [{ providerId: 'anthropic', key: 'sk-ant-test' }]);
  assert.equal(JSON.stringify(io.lines).includes('sk-ant-test'), false, 'the key is never printed');
  const saved = service.calls.setRoleDefaults[0];
  assert.equal(saved.pm, 'anthropic/claude-flagship');
  assert.equal(saved.tech_lead, 'anthropic/claude-flagship');
  assert.equal(saved.developer, 'anthropic/claude-mid');
  assert.equal(saved.artist, 'anthropic/claude-mid');
});

test('wizard: local endpoint route + all-local preset', async () => {
  const service = fakeService();
  const io = scriptedIo({
    choose: [1, 0, 2], // access menu: local -> access menu: done -> strategy: all-local
    input: [''], // accept the default URL
    confirm: [false],
  });
  const result = await runConfigWizard({ service, io, localBaseUrlDefault: 'http://127.0.0.1:18080/v1' });
  assert.equal(result.saved, true);
  assert.equal(service.calls.upsertCustomProvider[0].id, 'local');
  assert.equal(service.calls.upsertCustomProvider[0].provider.baseUrl, 'http://127.0.0.1:18080/v1');
  assert.equal(service.calls.upsertCustomProvider[0].provider.models[0].id, 'qwen-local');
  const saved = service.calls.setRoleDefaults[0];
  assert.ok(Object.values(saved).every(ref => ref === 'local/qwen-local'));
});

test('wizard: aborting the access menu saves nothing', async () => {
  const service = fakeService();
  const io = scriptedIo({ choose: [2] }); // key, local, abort
  const result = await runConfigWizard({ service, io, localBaseUrlDefault: 'http://127.0.0.1:9/v1' });
  assert.equal(result.aborted, true);
  assert.equal(service.calls.setRoleDefaults.length, 0);
});

test('wizard: failed validation + user declines -> role defaults are not saved', async () => {
  const service = fakeService({
    configuredProviders: () => [{ id: 'anthropic', source: 'pi-auth' }],
    validateRoleModels: async roleModels => ({
      complete: true,
      completenessError: null,
      roles: Object.fromEntries(Object.entries(roleModels).map(([role, ref]) => [role,
        role === 'developer' ? { ref, ok: false, reason: 'MODEL_NOT_FOUND' } : { ref, ok: true, cost: { input: 1, output: 1 } }])),
    }),
  });
  const io = scriptedIo({
    choose: [0, 0], // access menu: done -> strategy: quality
    confirm: [false], // do not save despite failures
  });
  const result = await runConfigWizard({ service, io, localBaseUrlDefault: 'http://127.0.0.1:9/v1' });
  assert.equal(result.saved, false);
  assert.equal(result.stage, 'validation');
  assert.equal(service.calls.setRoleDefaults.length, 0);
});
