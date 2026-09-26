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
const providerAPort = 18081;
const providerBPort = 18082;
const gatewayPort = 18999;
const token = 'ariad-ci-token';
mkdirSync(stateDir, { recursive: true });

const config = {
  gateway: { mode: 'local', port: gatewayPort, auth: { mode: 'token', token } },
  agents: { defaults: { model: { primary: 'fakea/default' }, timeoutSeconds: 30 } },
  models: {
    catalogRefresh: { enabled: false },
    providers: {
      fakea: {
        baseUrl: `http://127.0.0.1:${providerAPort}/v1`,
        apiKey: 'fake-a-key',
        api: 'openai-completions',
        models: [
          { id: 'default', name: 'Ariad CI Frontdesk', contextWindow: 32768, maxTokens: 8192, input: ['text'] },
        ],
      },
      fakeb: {
        baseUrl: `http://127.0.0.1:${providerBPort}/v1`,
        apiKey: 'fake-b-key',
        api: 'openai-completions',
        models: [
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
          allowedModels: ['fakeb/role'],
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

const providerA = spawn(process.execPath, ['test/fake-openai-server.mjs'], {
  cwd: pluginDir,
  env: { ...env, ARIAD_FAKE_PROVIDER_PORT: String(providerAPort), ARIAD_FAKE_PROVIDER_LABEL: 'A' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const providerB = spawn(process.execPath, ['test/fake-openai-server.mjs'], {
  cwd: pluginDir,
  env: { ...env, ARIAD_FAKE_PROVIDER_PORT: String(providerBPort), ARIAD_FAKE_PROVIDER_LABEL: 'B' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const gateway = spawn(openclaw, [
  'gateway', 'run',
  '--port', String(gatewayPort),
  '--bind', 'loopback',
  '--auth', 'token',
  '--token', token,
], { cwd: pluginDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

let providerALog = '';
let providerBLog = '';
let gatewayLog = '';
providerA.stdout.on('data', chunk => { providerALog += chunk; });
providerA.stderr.on('data', chunk => { providerALog += chunk; });
providerB.stdout.on('data', chunk => { providerBLog += chunk; });
providerB.stderr.on('data', chunk => { providerBLog += chunk; });
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
  throw new Error(`timed out waiting for ${label}\nstatus:\n${lastProjectStatus}\nproviderA:\n${providerALog}\nproviderB:\n${providerBLog}\ngateway:\n${gatewayLog}`);
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
  await waitFor(() => providerALog.includes('ARIAD_FAKE_PROVIDER_READY A'), 'fake provider A');
  await waitFor(() => providerBLog.includes('ARIAD_FAKE_PROVIDER_READY B'), 'fake provider B');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/readyz`)).ok, 'OpenClaw Gateway');

  const allRoleModels = Object.fromEntries(
    ['artist', 'developer', 'tester', 'reviewer', 'project_debugger', 'tech_lead', 'tech_lead_critic', 'pm']
      .map(role => [role, 'fakeb/role'])
  );
  gatewayCall('ariad.ci.project', {
    action: 'create',
    name: 'v2-production',
    goal: 'Create a tiny deterministic health endpoint and verify it.',
    roleModels: allRoleModels,
  });
  const frontdeskStart = spawnSync(openclaw, [
    'agent',
    '--agent', 'main',
    '--message', 'ARIAD_E2E_START_PROJECT v2-production',
    '--json',
    '--timeout', '30',
  ], {
    cwd: pluginDir,
    env,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(
    frontdeskStart.status,
    0,
    `frontdesk agent start failed\nstdout:\n${frontdeskStart.stdout}\nstderr:\n${frontdeskStart.stderr}\ngateway:\n${gatewayLog}`
  );
  await waitFor(
    () => providerALog.includes('ARIAD_FAKE_FRONTDESK_TOOL_CALL action=start project=v2-production'),
    'frontdesk ariad_project start tool call'
  );
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
      const error = new Error(`v2 project stopped before success: ${status}\nproviderA:\n${providerALog}\nproviderB:\n${providerBLog}\ngateway:\n${gatewayLog}`);
      error.fatal = true;
      throw error;
    }
    return /"executionState"\s*:\s*"SUCCEEDED"/.test(status);
  }, 'production v2 project success');

  assert.match(status, /"runtime"\s*:\s*"v2"/);
  assert.match(status, /"projectVersion"\s*:\s*1/);
  assert.match(status, /"executionCapabilities"\s*:\s*\[[^\]]*"linux\.native"/);
  await waitFor(
    () => providerBLog.includes('ARIAD_FAKE_MODEL provider=B model=role'),
    'explicit Ariad role model override',
    5_000
  );

  const frontdeskIterate = spawnSync(openclaw, [
    'agent',
    '--agent', 'main',
    '--message', 'ARIAD_E2E_ITERATE_PROJECT v2-production',
    '--json',
    '--timeout', '30',
  ], {
    cwd: pluginDir,
    env,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(
    frontdeskIterate.status,
    0,
    `frontdesk agent iterate failed\nstdout:\n${frontdeskIterate.stdout}\nstderr:\n${frontdeskIterate.stderr}\ngateway:\n${gatewayLog}`
  );
  await waitFor(
    () => providerALog.includes('ARIAD_FAKE_FRONTDESK_TOOL_CALL action=iterate project=v2-production'),
    'frontdesk ariad_project iterate tool call'
  );
  const iteratingStatus = gatewayCall('ariad.ci.project', { action: 'status', name: 'v2-production' });
  assert.match(iteratingStatus, /"activeVersion"\s*:\s*2/);

  const snapshotPath = join(projectsRoot, 'v2-production', 'workspace', '.ariad', 'versions', 'v1', 'snapshot.json');
  assert.equal(existsSync(snapshotPath), true, 'iterate must create an immutable snapshot of the completed version');
  const versionOneSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.equal(versionOneSnapshot.projectVersion, 1);
  assert.equal(versionOneSnapshot.deliveryTasks.some(task => task.id === 'T1' && task.state === 'DONE'), true);

  let iterationStatus = '';
  await waitFor(() => {
    iterationStatus = gatewayCall('ariad.ci.project', { action: 'status', name: 'v2-production' });
    lastProjectStatus = iterationStatus;
    if (/"executionState"\s*:\s*"(FAILED|NEEDS_HUMAN)"/.test(iterationStatus)) {
      const error = new Error(`iteration stopped before success: ${iterationStatus}\nproviderA:\n${providerALog}\nproviderB:\n${providerBLog}\ngateway:\n${gatewayLog}`);
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
  assert.equal(tasks.find(task => task.id === 'T2')?.state, 'DONE');
  assert.equal(tasks.find(task => task.id === 'ROOT-V2')?.state, 'DONE');
  const structuredRoleResults = (t1?.history ?? []).filter(entry => entry?.source === 'role_result_tool');
  assert.equal(structuredRoleResults.some(entry => entry.role === 'developer'), true);
  assert.equal(structuredRoleResults.some(entry => entry.role === 'tester'), true);
  assert.equal(structuredRoleResults.some(entry => entry.role === 'reviewer'), true);
  assert.equal(incidentCount, 0, 'structured role submissions should avoid INVALID_ROLE_RESULT incidents');
  assert.equal(tasks.some(task => task.input?.purpose === 'PLANNER_CRITIC' && task.state === 'DONE'), true);
  assert.equal(tasks.some(task => task.input?.round === 2 && task.state === 'SKIPPED'), true, 'clean critic should skip later rounds');

  await waitFor(
    () => providerBLog.includes('ARIAD_FAKE_TOOL_CALL provider=B role=reviewer cycle=2 tool=ariad_reviewer_result'),
    'v2 reviewer structured result tool call',
    5_000
  );

  assert.notEqual(git(workspace, ['rev-list', '--count', 'HEAD']), '0');
  assert.equal(git(workspace, ['status', '--porcelain']), '');

  console.log('ARIAD_OPENCLAW_V2_PRODUCTION_E2E_OK');
} finally {
  gateway.kill('SIGTERM');
  providerA.kill('SIGTERM');
  providerB.kill('SIGTERM');
  await new Promise(resolveWait => setTimeout(resolveWait, 250));
  rmSync(root, { recursive: true, force: true });
}
