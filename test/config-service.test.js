import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAriadConfigService,
  probeLocalEndpoint,
  readPiModelsConfig,
} from '../src/runtime/config-service.js';
import { ensureLocalPiModelsConfig } from '../src/runtime/pi-agent-session-provider.js';

const ALL_ROLES = {
  tech_lead: 'mycloud/qwen3.8-27b',
  tech_lead_critic: 'mycloud/qwen3.8-27b',
  pm: 'mycloud/qwen3.8-27b',
  developer: 'mycloud/qwen3.8-27b',
  tester: 'mycloud/qwen3.8-27b',
  reviewer: 'mycloud/qwen3.8-27b',
  artist: 'mycloud/qwen3.8-27b',
  project_debugger: 'mycloud/qwen3.8-27b',
};

function tempService(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-config-'));
  const service = createAriadConfigService({
    modelsPath: join(dir, 'models.json'),
    authPath: join(dir, 'auth.json'),
    installConfigPath: join(dir, 'ariad-config.json'),
    ...extra,
  });
  return { dir, service };
}

const fakeRuntime = {
  getModel: (provider, model) => (provider === 'mycloud' && model === 'qwen3.8-27b'
    ? { contextWindow: 131072, maxTokens: 16384, cost: { input: 0, output: 0 } }
    : undefined),
};

test('custom providers round-trip through Pi models.json without leaking keys', () => {
  const { service, dir } = tempService();
  const saved = service.upsertCustomProvider('mycloud', {
    baseUrl: 'http://127.0.0.1:18080/v1',
    apiKey: 'sk-test-secret',
    models: [{ id: 'qwen3.8-27b', contextWindow: 131072 }],
  });
  assert.equal(saved.saved, true);
  assert.equal(saved.provider.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes('sk-test-secret'), false);

  const onDisk = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
  assert.equal(onDisk.providers.mycloud.apiKey, 'sk-test-secret');
  assert.equal(onDisk.providers.mycloud.api, 'openai-completions');
  assert.deepEqual(service.customProviders().map(p => p.id), ['mycloud']);

  assert.deepEqual(service.removeCustomProvider('mycloud'), { removed: true, providerId: 'mycloud' });
  assert.deepEqual(service.customProviders(), []);
  assert.deepEqual(service.removeCustomProvider('mycloud'), { removed: false, providerId: 'mycloud' });
});

test('role defaults require a complete mapping and read back', () => {
  const { service } = tempService();
  assert.equal(service.roleDefaults(), null);
  assert.throws(() => service.setRoleDefaults({ developer: 'mycloud/qwen3.8-27b' }), /ROLE_MODELS_INCOMPLETE|missing/i);
  const saved = service.setRoleDefaults(ALL_ROLES);
  assert.equal(saved.developer, 'mycloud/qwen3.8-27b');
  assert.deepEqual(service.roleDefaults(), saved);
});

test('role refs resolve against Pi (catalog or models.json), not an Ariad list', async () => {
  const { service } = tempService({ runtimeFactory: async () => fakeRuntime });
  const ok = await service.resolveRoleRef('mycloud/qwen3.8-27b');
  assert.equal(ok.ok, true);
  assert.equal(ok.contextWindow, 131072);
  const missing = await service.resolveRoleRef('mycloud/nope');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /MODEL_NOT_FOUND/);

  const validation = await service.validateRoleModels(ALL_ROLES);
  assert.equal(validation.complete, true);
  assert.equal(validation.roles.pm.ok, true);
  const partial = await service.validateRoleModels({ developer: 'mycloud/qwen3.8-27b' });
  assert.equal(partial.complete, false);
});

test('endpoint probe reports reachability and loaded models', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
    } else {
      response.writeHead(404); response.end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address();
    const probe = await probeLocalEndpoint(`http://127.0.0.1:${port}/v1`);
    assert.deepEqual(probe, { baseUrl: `http://127.0.0.1:${port}/v1`, reachable: true, models: ['qwen3.8-27b'] });
  } finally {
    await new Promise(done => server.close(done));
  }
  const down = await probeLocalEndpoint('http://127.0.0.1:1/v1', { timeoutMs: 1000 });
  assert.equal(down.reachable, false);
});

test('workspace models config inherits global Pi providers, generated llamacpp fills gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-config-merge-'));
  const globalPath = join(dir, 'global-models.json');
  writeFileSync(globalPath, JSON.stringify({
    providers: {
      mycloud: { baseUrl: 'http://127.0.0.1:18080/v1', api: 'openai-completions', models: [{ id: 'qwen3.8-27b' }] },
    },
  }));
  const workspacePath = join(dir, 'workspace-models.json');
  const previous = process.env.ARIAD_PI_MODELS_PATH;
  process.env.ARIAD_PI_MODELS_PATH = globalPath;
  try {
    ensureLocalPiModelsConfig(workspacePath, { developer: 'llamacpp/qwen3.8-27b' });
  } finally {
    if (previous == null) delete process.env.ARIAD_PI_MODELS_PATH;
    else process.env.ARIAD_PI_MODELS_PATH = previous;
  }
  const merged = JSON.parse(readFileSync(workspacePath, 'utf8'));
  assert.ok(merged.providers.mycloud, 'global custom provider flows into the workspace config');
  assert.ok(merged.providers.llamacpp, 'generated llamacpp provider still present');
  const globalAfter = JSON.parse(readFileSync(globalPath, 'utf8'));
  assert.deepEqual(Object.keys(globalAfter.providers), ['mycloud'], 'global file is not mutated');
});

test('malformed global models.json fails loudly with its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-config-bad-'));
  const path = join(dir, 'models.json');
  writeFileSync(path, '{not json');
  assert.throws(() => readPiModelsConfig(path), /PI_MODELS_CONFIG_INVALID/);
});


test('saveApiKey writes a Pi api_key credential, preserves OAuth, refuses to clobber it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-auth-'));
  const authPath = join(dir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'tok', refresh: 'ref', expires: 1 } }));
  const service = createAriadConfigService({
    modelsPath: join(dir, 'models.json'),
    authPath,
    installConfigPath: join(dir, 'ariad-config.json'),
  });
  const saved = service.saveApiKey('anthropic', 'sk-ant-xyz');
  assert.deepEqual(saved, { saved: true, providerId: 'anthropic' });
  assert.equal(JSON.stringify(saved).includes('sk-ant-xyz'), false);
  const auth = JSON.parse(readFileSync(authPath, 'utf8'));
  assert.deepEqual(auth.anthropic, { type: 'api_key', key: 'sk-ant-xyz' });
  assert.equal(auth['openai-codex'].type, 'oauth', 'existing OAuth entry is preserved');
  assert.throws(() => service.saveApiKey('openai-codex', 'sk-new'), /ARIAD_AUTH_OAUTH_EXISTS/);
  assert.throws(() => service.saveApiKey('anthropic', '  '), /CONFIG_API_KEY_REQUIRED/);
});
