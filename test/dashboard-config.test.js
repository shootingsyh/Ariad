import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AriadDashboardService } from '../src/runtime/dashboard-service.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { createAriadConfigService } from '../src/runtime/config-service.js';

const ALL_ROLES = Object.fromEntries(
  ['tech_lead', 'tech_lead_critic', 'pm', 'developer', 'tester', 'reviewer', 'artist', 'project_debugger']
    .map(role => [role, 'mycloud/qwen3.8-27b']),
);

const fakeRuntime = {
  getModel: (provider, model) => (provider === 'mycloud' && model === 'qwen3.8-27b'
    ? { contextWindow: 131072, maxTokens: 16384, cost: { input: 0, output: 0 } }
    : undefined),
  getProvider: providerId => (providerId === 'mycloud' ? { id: 'mycloud' } : undefined),
  getModels: providerId => (providerId === 'mycloud'
    ? [{ id: 'qwen3.8-27b', contextWindow: 131072, maxTokens: 16384, cost: { input: 0, output: 0 } }]
    : []),
};

async function startDashboard(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-dashcfg-'));
  const manager = new AriadProjectManager({ projectsRoot: join(dir, 'projects') });
  const configService = createAriadConfigService({
    modelsPath: join(dir, 'models.json'),
    authPath: join(dir, 'auth.json'),
    installConfigPath: join(dir, 'ariad-config.json'),
    runtimeFactory: async () => fakeRuntime,
  });
  const dashboard = new AriadDashboardService({ manager, host: '127.0.0.1', port: 0 });
  dashboard.configServiceOverride = configService;
  await dashboard.start();
  t.after(() => dashboard.stop());
  return { dir, manager, configService, base: dashboard.url };
}

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => null), text: '' };
}

test('dashboard config API: keys, providers, role defaults - and keys never come back', async t => {
  const { dir, base } = await startDashboard(t);

  const page = await (await fetch(base + '/')).text();
  assert.ok(page.includes('configBtn') && page.includes('configView'), 'config UI is in the page');

  const readOnly = await fetch(base + '/api/projects', { method: 'POST' });
  assert.equal(readOnly.status, 405, 'non-config POSTs stay read-only');

  const savedKey = await post(base, '/api/config/api-key', { providerId: 'anthropic', key: 'sk-ant-secret-1' });
  assert.equal(savedKey.status, 200);
  assert.equal(JSON.stringify(savedKey.body).includes('sk-ant-secret-1'), false);
  const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
  assert.deepEqual(auth.anthropic, { type: 'api_key', key: 'sk-ant-secret-1' });

  const provider = await post(base, '/api/config/providers', {
    id: 'mycloud', baseUrl: 'http://127.0.0.1:18080/v1', models: [{ id: 'qwen3.8-27b' }],
  });
  assert.equal(provider.body.saved, true);

  const state = await (await fetch(base + '/api/config')).json();
  assert.equal(state.customProviders[0].id, 'mycloud');
  assert.equal(state.modelsByProvider.mycloud[0].id, 'qwen3.8-27b');
  assert.equal(JSON.stringify(state).includes('sk-ant-secret-1'), false, 'config state never contains a stored key');

  const roles = await post(base, '/api/config/role-defaults', { roleModels: ALL_ROLES });
  assert.equal(roles.body.saved, true);
  assert.equal(roles.body.validation.roles.pm.ok, true);

  const incomplete = await post(base, '/api/config/role-defaults', { roleModels: { pm: 'mycloud/qwen3.8-27b' } });
  assert.equal(incomplete.status, 400, 'incomplete role defaults are rejected');

  const removed = await post(base, '/api/config/providers/remove', { id: 'mycloud' });
  assert.equal(removed.body.removed, true);
});

test('dashboard probe endpoint reaches a local OpenAI-compatible server', async t => {
  const { base } = await startDashboard(t);
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const probe = await post(base, '/api/config/probe', { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  assert.equal(probe.body.reachable, true);
  assert.deepEqual(probe.body.models, ['qwen3.8-27b']);
});

test('dashboard project slots: report renders and install refuses non-installable slots', async t => {
  const { manager, base } = await startDashboard(t);
  manager.create('demo', { goal: 'slots demo', roleModels: ALL_ROLES });
  const slots = await (await fetch(base + '/api/projects/demo/slots')).json();
  const artist = slots.slots.find(slot => slot.slotId === 'feature:artist');
  assert.equal(artist.state, 'ready');
  const install = await post(base, '/api/projects/demo/slots/install', { slotId: 'feature:artist' });
  assert.equal(install.body.ok, false);
  assert.equal(install.body.reason, 'CONFIGURE_NOT_INSTALL');
  assert.ok(install.body.slots, 'install responses carry the refreshed slot report');
  const unknown = await post(base, '/api/projects/demo/slots/install', { slotId: 'lsp:cobol' });
  assert.equal(unknown.body.reason, 'SLOT_NOT_FOUND');
});
