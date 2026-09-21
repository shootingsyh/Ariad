import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'ariad-openclaw-v2-e2e-'));
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
  agents: { defaults: { model: { primary: 'ariadfake/default' }, timeoutSeconds: 30 } },
  models: {
    catalogRefresh: { enabled: false },
    providers: {
      ariadfake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: 'fake-key',
        api: 'openai-completions',
        models: [
          { id: 'default', name: 'Ariad CI Default', contextWindow: 32768, maxTokens: 8192, input: ['text'] },
          { id: 'role', name: 'Ariad CI Role', contextWindow: 32768, maxTokens: 8192, input: ['text'] },
        ],
      },
    },
  },
  plugins: {
    load: { paths: [pluginDir] },
    entries: {
      ariad: {
        enabled: true,
        subagent: {
          allowModelOverride: true,
          allowedModels: ['ariadfake/role'],
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
  ARIAD_PROJECTS_ROOT: projectsRoot,
  ARIAD_CI_RUNTIME_PROBE: '1',
  ARIAD_SOURCE_CONTROL_PUSH: '0',
  NO_COLOR: '1',
};

const provider = spawn(process.execPath, ['test/fake-openai-server.mjs'], {
  cwd: pluginDir,
  env: { ...env, ARIAD_FAKE_PROVIDER_PORT: String(providerPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const gateway = spawn(openclaw, [
  'gateway', 'run',
  '--port', String(gatewayPort),
  '--bind', 'loopback',
  '--auth', 'token',
  '--token', token,
], { cwd: pluginDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

let providerLog = '';
let gatewayLog = '';
provider.stdout.on('data', chunk => { providerLog += chunk; });
provider.stderr.on('data', chunk => { providerLog += chunk; });
gateway.stdout.on('data', chunk => { gatewayLog += chunk; });
gateway.stderr.on('data', chunk => { gatewayLog += chunk; });

let lastProjectStatus = '';

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      if (error?.fatal) throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error(`timed out waiting for ${label}\nstatus:\n${lastProjectStatus}\nprovider:\n${providerLog}\ngateway:\n${gatewayLog}`);
}

function gatewayCall(method, params = {}) {
  const call = spawnSync(openclaw, [
    'gateway', 'call', method,
    '--params', JSON.stringify(params),
    '--port', String(gatewayPort),
    '--token', token,
    '--json',
    '--timeout', '45000',
  ], {
    cwd: pluginDir,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(
    call.status,
    0,
    `gateway call ${method} failed\nstdout:\n${call.stdout}\nstderr:\n${call.stderr}\ngateway:\n${gatewayLog}`
  );
  return `${call.stdout}\n${call.stderr}`;
}

function git(cwd, args) {
  const call = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(call.status, 0, `git ${args.join(' ')} failed\n${call.stderr}`);
  return call.stdout.trim();
}

try {
  await waitFor(() => providerLog.includes('ARIAD_FAKE_PROVIDER_READY'), 'fake provider');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/readyz`)).ok, 'OpenClaw Gateway');

  gatewayCall('ariad.ci.project', {
    action: 'create',
    name: 'v2-production',
    goal: 'Create a tiny deterministic health endpoint and verify it.',
  });
  gatewayCall('ariad.ci.project', { action: 'start', name: 'v2-production' });
  const paused = gatewayCall('ariad.ci.project', { action: 'pause', name: 'v2-production' });
  assert.match(paused, /"desiredState"\s*:\s*"PAUSED"/);

  await new Promise(resolvePause => setTimeout(resolvePause, 1200));
  const pausedStatus = gatewayCall('ariad.ci.project', { action: 'status', name: 'v2-production' });
  assert.match(pausedStatus, /"desiredState"\s*:\s*"PAUSED"/);
  assert.doesNotMatch(pausedStatus, /"executionState"\s*:\s*"SUCCEEDED"/, 'pause must freeze scheduler before project completion');

  const resumed = gatewayCall('ariad.ci.project', { action: 'resume', name: 'v2-production' });
  assert.match(resumed, /"desiredState"\s*:\s*"RUNNING"/);

  let status = '';
  await waitFor(() => {
    status = gatewayCall('ariad.ci.project', { action: 'status', name: 'v2-production' });
    lastProjectStatus = status;
    if (/"executionState"\s*:\s*"(FAILED|NEEDS_HUMAN)"/.test(status)) {
      const error = new Error(`v2 project stopped before success: ${status}\nprovider:\n${providerLog}\ngateway:\n${gatewayLog}`);
      error.fatal = true;
      throw error;
    }
    return /"executionState"\s*:\s*"SUCCEEDED"/.test(status);
  }, 'production v2 project success');

  assert.match(status, /"runtime"\s*:\s*"v2"/);
  assert.match(status, /"projectVersion"\s*:\s*1/);
  await waitFor(
    () => providerLog.includes('ARIAD_FAKE_MODEL model=role'),
    'explicit Ariad role model override',
    5_000
  );

  const iterate = gatewayCall('ariad.ci.project', {
    action: 'iterate',
    name: 'v2-production',
    request: 'Add a small follow-up improvement and revalidate the completed project.',
  });
  assert.match(iterate, /"activeVersion"\s*:\s*2/);

  let iterationStatus = '';
  await waitFor(() => {
    iterationStatus = gatewayCall('ariad.ci.project', { action: 'status', name: 'v2-production' });
    lastProjectStatus = iterationStatus;
    if (/"executionState"\s*:\s*"(FAILED|NEEDS_HUMAN)"/.test(iterationStatus)) {
      const error = new Error(`iteration stopped before success: ${iterationStatus}\nprovider:\n${providerLog}\ngateway:\n${gatewayLog}`);
      error.fatal = true;
      throw error;
    }
    return /"executionState"\s*:\s*"SUCCEEDED"/.test(iterationStatus)
      && /"projectVersion"\s*:\s*2/.test(iterationStatus);
  }, 'second project version success');

  const projectRoot = join(projectsRoot, 'v2-production');
  const workspace = join(projectRoot, 'workspace');
  const dbPath = join(workspace, '.ariad', 'state.db');

  assert.equal(existsSync(join(workspace, 'health.txt')), true);
  assert.equal(readFileSync(join(workspace, 'health.txt'), 'utf8'), 'status=healthy\ncycle=2\n');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const planning = db.prepare('SELECT state, COUNT(*) count FROM v2_planning_requests GROUP BY state').all();
  const taskRows = db.prepare('SELECT id, data_json FROM v2_tasks ORDER BY rowid').all();
  const incidentCount = db.prepare('SELECT COUNT(*) count FROM v2_system_incidents').get().count;
  db.close();

  assert.equal(planning.some(row => row.state === 'PLANNED' && row.count >= 1), true);
  const tasks = taskRows.map(row => ({ id: row.id, ...JSON.parse(row.data_json) }));
  const t1 = tasks.find(task => task.id === 'T1');
  assert.equal(t1?.state, 'DONE');
  assert.equal(tasks.find(task => task.id === 'ROOT')?.state, 'DONE');
  const structuredRoleResults = (t1?.history ?? []).filter(entry => entry?.source === 'role_result_tool');
  assert.equal(structuredRoleResults.some(entry => entry.role === 'developer'), true);
  assert.equal(structuredRoleResults.some(entry => entry.role === 'tester'), true);
  assert.equal(structuredRoleResults.some(entry => entry.role === 'reviewer'), true);
  assert.equal(incidentCount, 0, 'structured role submissions should avoid INVALID_ROLE_RESULT incidents');
  assert.equal(tasks.some(task => task.input?.purpose === 'PLANNER_CRITIC' && task.state === 'DONE'), true);
  assert.equal(tasks.some(task => task.input?.round === 2 && task.state === 'SKIPPED'), true, 'clean critic should skip later rounds');

  await waitFor(
    () => providerLog.includes('ARIAD_FAKE_TOOL_CALL role=reviewer cycle=2 tool=ariad_reviewer_result'),
    'v2 reviewer structured result tool call',
    5_000
  );

  assert.notEqual(git(workspace, ['rev-list', '--count', 'HEAD']), '0');
  assert.equal(git(workspace, ['status', '--porcelain']), '');

  console.log('ARIAD_OPENCLAW_V2_PRODUCTION_E2E_OK');
} finally {
  gateway.kill('SIGTERM');
  provider.kill('SIGTERM');
  await new Promise(resolveWait => setTimeout(resolveWait, 250));
  rmSync(root, { recursive: true, force: true });
}
