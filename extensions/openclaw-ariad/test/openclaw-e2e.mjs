import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

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
    catalogRefresh: { enabled: false },
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
    entries: { ariad: { enabled: true } },
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

function git(cwd, args) {
  const call = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(call.status, 0, `git ${args.join(' ')} failed\nstdout:\n${call.stdout}\nstderr:\n${call.stderr}`);
  return call.stdout.trim();
}

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

async function waitFor(check, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for ${label}\nprovider:\n${providerLog}\ngateway:\n${gatewayLog}`);
}

function gatewayCall(method, params) {
  const call = spawnSync(openclaw, [
    'gateway', 'call', method,
    '--params', JSON.stringify(params),
    '--port', String(gatewayPort), '--token', token, '--json', '--timeout', '30000',
  ], { cwd: pluginDir, env, encoding: 'utf8', timeout: 45000 });
  assert.equal(call.status, 0, `gateway call ${method} failed\nstdout:\n${call.stdout}\nstderr:\n${call.stderr}\ngateway:\n${gatewayLog}`);
  return `${call.stdout}\n${call.stderr}`;
}

try {
  await waitFor(() => providerLog.includes('ARIAD_FAKE_PROVIDER_READY'), 'fake provider');
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
    return response.ok;
  }, 'OpenClaw Gateway');

  const roleOutput = gatewayCall('ariad.ci.roleRun', {
    role: 'reviewer',
    context: { taskId: 'probe', acceptanceCriteria: ['fake provider must return PASS'] },
  });
  assert.match(roleOutput, /fake-provider/, roleOutput);
  assert.match(roleOutput, /COMPLETED/, roleOutput);
  assert.match(roleOutput, /PASS/, roleOutput);

  gatewayCall('ariad.ci.project', {
    action: 'create',
    name: 'full-e2e',
    goal: 'Create a tiny deterministic health endpoint and verify it.',
  });

  const projectRoot = join(projectsRoot, 'full-e2e');
  const workspace = join(projectRoot, 'workspace');
  git(workspace, ['init', '-b', 'main']);
  writeFileSync(join(workspace, 'README.md'), '# Ariad E2E\n');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['-c', 'user.name=Ariad CI', '-c', 'user.email=ariad-ci@localhost', 'commit', '-m', 'seed']);
  const seedCommit = git(workspace, ['rev-parse', 'HEAD']);
  writeFileSync(join(workspace, 'health.txt'), 'fake developer workspace change\n');

  gatewayCall('ariad.ci.project', { action: 'start', name: 'full-e2e' });

  let lastStatus = '';
  await waitFor(() => {
    lastStatus = gatewayCall('ariad.ci.project', { action: 'status', name: 'full-e2e' });
    if (/"phase"\s*:\s*"FAILED"/.test(lastStatus)) {
      throw new Error(`project controller failed: ${lastStatus}`);
    }
    return /"phase"\s*:\s*"SUCCEEDED"/.test(lastStatus);
  }, 'full Ariad project success');

  const graphPath = join(projectRoot, '.ariad', 'task-graph.json');
  const dbPath = join(projectRoot, '.ariad', 'state.db');
  assert.equal(existsSync(graphPath), true, 'PM task graph must be durable');
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.deepEqual(graph.tasks.map((task) => task.id), ['T1']);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const state = db.prepare('SELECT stage, dev_cycle, strategy_epoch, status FROM workflow_state WHERE task_id = ?').get('T1');
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.dev_cycle, 2, 'reviewer NOT_PASS must cause semantic cycle 2');
  assert.equal(state.strategy_epoch, 1);

  const runs = db.prepare('SELECT task_id, role, attempt, state FROM runs ORDER BY seq').all();
  db.close();
  assert.deepEqual(
    runs.map((run) => `${run.task_id}:${run.role}:${run.state}`),
    [
      '__project_plan__:pm:COMPLETED',
      'T1:developer:COMPLETED',
      'T1:tester:COMPLETED',
      'T1:reviewer:COMPLETED',
      'T1:developer:COMPLETED',
      'T1:tester:COMPLETED',
      'T1:reviewer:COMPLETED',
    ],
  );
  assert.deepEqual(runs.filter((run) => run.role === 'reviewer').map((run) => run.attempt), [1, 2]);

  const finalCommit = git(workspace, ['rev-parse', 'HEAD']);
  assert.notEqual(finalCommit, seedCommit, 'source-control finalizer must create a commit');
  assert.equal(git(workspace, ['status', '--porcelain']), '', 'workspace must be clean after finalization');
  assert.equal(git(workspace, ['rev-list', '--count', 'HEAD']), '2');
  assert.match(git(workspace, ['log', '-1', '--pretty=%s']), /^Ariad: T1 \(strategy 1, cycle 2\)$/);
  assert.equal(git(workspace, ['remote']), '', 'CI fixture intentionally has no remote, proving no push was attempted');

  console.log('ARIAD_OPENCLAW_FULL_PROJECT_E2E_OK');
} finally {
  gateway.kill('SIGTERM');
  provider.kill('SIGTERM');
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  rmSync(root, { recursive: true, force: true });
}
