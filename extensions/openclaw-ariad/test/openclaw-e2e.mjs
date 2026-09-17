import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'ariad-openclaw-e2e-'));
const stateDir = join(root, 'state');
const configPath = join(stateDir, 'openclaw.json');
const projectsRoot = join(root, 'projects');
const pluginDir = resolve(process.cwd());
const openclaw = resolve('node_modules/.bin/openclaw');
const providerPort = 18081;
const gatewayPort = 18999;
const token = 'ariad-ci-token';
mkdirSync(stateDir, { recursive: true });

const config = {
  gateway: { mode: 'local', auth: { mode: 'token', token } },
  agents: {
    defaults: {
      model: { primary: 'ariadfake/fake' },
      timeoutSeconds: 30,
    },
  },
  models: {
    providers: {
      ariadfake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: 'fake-key',
        api: 'openai-completions',
        models: [{ id: 'fake', name: 'Ariad CI Fake', contextWindow: 8192, maxTokens: 1024, input: ['text'] }],
      },
    },
  },
  plugins: {
    load: { paths: [pluginDir] },
    entries: {
      ariad: {
        enabled: true,
        config: {
          projectsRoot,
          subagentAgentId: 'main',
          subagentProvider: 'ariadfake',
          subagentModel: 'fake',
          ciRuntimeProbeEnabled: true,
        },
        subagent: {
          allowModelOverride: true,
          allowedModels: ['ariadfake/fake'],
        },
      },
    },
  },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_OFFLINE: '1',
  NO_COLOR: '1',
};

const provider = spawn(process.execPath, ['test/fake-openai-server.mjs'], {
  cwd: pluginDir,
  env: { ...env, ARIAD_FAKE_PROVIDER_PORT: String(providerPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const gateway = spawn(openclaw, ['gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback', '--auth', 'token', '--token', token], {
  cwd: pluginDir,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let providerLog = '';
let gatewayLog = '';
provider.stdout.on('data', (chunk) => { providerLog += chunk; });
provider.stderr.on('data', (chunk) => { providerLog += chunk; });
gateway.stdout.on('data', (chunk) => { gatewayLog += chunk; });
gateway.stderr.on('data', (chunk) => { gatewayLog += chunk; });

async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for ${label}\nprovider:\n${providerLog}\ngateway:\n${gatewayLog}`);
}

try {
  await waitFor(() => providerLog.includes('ARIAD_FAKE_PROVIDER_READY'), 'fake provider');
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
    return response.ok;
  }, 'OpenClaw Gateway');

  const call = spawnSync(openclaw, [
    'gateway', 'call', 'ariad.ci.roleRun',
    '--params', JSON.stringify({ role: 'reviewer', context: { taskId: 'T1', acceptanceCriteria: ['fake provider must return PASS'] } }),
    '--port', String(gatewayPort), '--token', token, '--json', '--timeout', '30000',
  ], { cwd: pluginDir, env, encoding: 'utf8', timeout: 45000 });

  assert.equal(call.status, 0, `gateway call failed\nstdout:\n${call.stdout}\nstderr:\n${call.stderr}\ngateway:\n${gatewayLog}`);
  const output = `${call.stdout}\n${call.stderr}`;
  assert.match(output, /fake-provider/, output);
  assert.match(output, /COMPLETED/, output);
  assert.match(output, /PASS/, output);
  console.log('ARIAD_OPENCLAW_E2E_OK');
} finally {
  gateway.kill('SIGTERM');
  provider.kill('SIGTERM');
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  rmSync(root, { recursive: true, force: true });
}
