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
  agents: { defaults: { model: { primary: 'ariadfake/fake' }, timeoutSeconds: 30 } },
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
  plugins: { load: { paths: [pluginDir] }, entries: { ariad: { enabled: true } } },
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

const provider = spawn(process.execPath, ['test/fake-openai-server.mjs'], { cwd: pluginDir, env: { ...env, ARIAD_FAKE_PROVIDER_PORT: String(providerPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
const gateway = spawn(openclaw, ['gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback', '--auth', 'token', '--token', token], { cwd: pluginDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

let providerLog = '';
let gatewayLog = '';
provider.stdout.on('data', (chunk) => { providerLog += chunk; });
provider.stderr.on('data', (chunk) => { providerLog += chunk; });
gateway.stdout.on('data', (chunk) => { gatewayLog += chunk; });
gateway.stderr.on('data', (chunk) => { gatewayLog += chunk; });

async function waitFor(check, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for ${label}\nprovider:\n${providerLog}\ngateway:\n${gatewayLog}`);
}

function gatewayCall(method, params) {
  const call = spawnSync(openclaw, ['gateway', 'call', method, '--params', JSON.stringify(params), '--port', String(gatewayPort), '--token', token, '--json', '--timeout', '30000'], { cwd: pluginDir, env, encoding: 'utf8', timeout: 45000 });
  assert.equal(call.status, 0, `gateway call ${method} failed\nstdout:\n${call.stdout}\nstderr:\n${call.stderr}\ngateway:\n${gatewayLog}`);
  return `${call.stdout}\n${call.stderr}`;
}

try {
  await waitFor(() => providerLog.includes('ARIAD_FAKE_PROVIDER_READY'), 'fake provider');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/readyz`)).ok, 'OpenClaw Gateway');

  const roleOutput = gatewayCall('ariad.ci.roleRun', { role: 'reviewer', context: { taskId: 'probe', acceptanceCriteria: ['fake provider must return PASS'] } });
  assert.match(roleOutput, /fake-provider/, roleOutput);
  assert.match(roleOutput, /COMPLETED/, roleOutput);
  assert.match(roleOutput, /PASS/, roleOutput);

  gatewayCall('ariad.ci.project', { action: 'create', name: 'full-e2e', goal: 'Create a tiny deterministic health endpoint and verify it.' });

  const projectRoot = join(projectsRoot, 'full-e2e');
  const workspace = join(projectRoot, 'workspace');
  git(workspace, ['init', '-b', 'main']);
  writeFileSync(join(workspace, 'README.md'), '# Ariad E2E existing project\n');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['-c', 'user.name=Ariad CI', '-c', 'user.email=ariad-ci@localhost', 'commit', '-m', 'seed']);
  const seedCommit = git(workspace, ['rev-parse', 'HEAD']);
  assert.equal(existsSync(join(workspace, 'health.txt')), false);

  gatewayCall('ariad.ci.project', { action: 'start', name: 'full-e2e' });
  let lastStatus = '';
  await waitFor(() => {
    lastStatus = gatewayCall('ariad.ci.project', { action: 'status', name: 'full-e2e' });
    if (/"phase"\s*:\s*"FAILED"/.test(lastStatus)) throw new Error(`project controller failed: ${lastStatus}`);
    return /"phase"\s*:\s*"SUCCEEDED"/.test(lastStatus);
  }, 'full Ariad project success');

  const graphPath = join(projectRoot, '.ariad', 'task-graph.json');
  const modelDir = join(projectRoot, '.ariad', 'project');
  const dbPath = join(projectRoot, '.ariad', 'state.db');
  assert.equal(existsSync(graphPath), true, 'approved task graph must be durable');
  for (const name of ['brief.json', 'current-state.json', 'architecture.json', 'contracts.json', 'dependencies.json', 'vertical-slices.json', 'technical-direction.json', 'decomposition.json', 'current-state-review.json', 'plan-review.json', 'task-graph.json']) {
    assert.equal(existsSync(join(modelDir, name)), true, `${name} must be durable`);
  }
  const currentState = JSON.parse(readFileSync(join(modelDir, 'current-state.json'), 'utf8'));
  assert.equal(currentState.existingProject, true);
  assert.match(currentState.summary, /Existing/);
  assert.equal(JSON.parse(readFileSync(join(modelDir, 'current-state-review.json'), 'utf8')).outcome, 'CURRENT_STATE_ACKNOWLEDGED');
  assert.equal(JSON.parse(readFileSync(join(modelDir, 'plan-review.json'), 'utf8')).outcome, 'PLAN_ACCEPTED');

  const contracts = JSON.parse(readFileSync(join(modelDir, 'contracts.json'), 'utf8'));
  assert.equal(contracts[0].interfaceTaskId, 'T_INTERFACE');
  assert.equal(contracts[0].contractTestTaskId, 'T_CONTRACT_TEST');
  assert.equal(contracts[0].fakeTaskId, 'T_FAKE');
  const verticalSlices = JSON.parse(readFileSync(join(modelDir, 'vertical-slices.json'), 'utf8'));
  assert.equal(verticalSlices[0].skeletonTaskId, 'T1');

  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.equal(graph.approvedBy, 'pm');
  assert.deepEqual(graph.tasks.map((task) => task.id), ['T_INTERFACE', 'T_CONTRACT_TEST', 'T_FAKE', 'T1']);
  assert.deepEqual(graph.tasks.map((task) => task.kind), ['CONTRACT_INTERFACE', 'CONTRACT_TEST', 'FAKE_PROVIDER', 'VERTICAL_SKELETON']);
  assert.equal(graph.tasks.every((task) => task.atomic === true), true);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const states = db.prepare('SELECT task_id, stage, dev_cycle, strategy_epoch, status FROM workflow_state ORDER BY task_id').all();
  assert.equal(states.length, 4);
  assert.equal(states.every((state) => state.status === 'SUCCEEDED'), true);
  const skeletonState = states.find((state) => state.task_id === 'T1');
  assert.equal(skeletonState.dev_cycle, 2);
  assert.equal(skeletonState.strategy_epoch, 1);
  for (const taskId of ['T_INTERFACE', 'T_CONTRACT_TEST', 'T_FAKE']) {
    assert.equal(states.find((state) => state.task_id === taskId).dev_cycle, 1);
  }
  const runs = db.prepare('SELECT task_id, role, attempt, state, result_json FROM runs ORDER BY seq').all();
  db.close();
  assert.deepEqual(runs.slice(0, 4).map((run) => `${run.task_id}:${run.role}:${run.state}`), [
    '__project_discovery__:tech_lead:COMPLETED',
    '__project_current_state_review__:pm:COMPLETED',
    '__project_plan__:tech_lead:COMPLETED',
    '__project_plan_review__:pm:COMPLETED',
  ]);
  for (const taskId of ['T_INTERFACE', 'T_CONTRACT_TEST', 'T_FAKE']) {
    assert.deepEqual(runs.filter((run) => run.task_id === taskId).map((run) => run.role), ['developer', 'tester', 'reviewer']);
  }
  assert.deepEqual(runs.filter((run) => run.task_id === 'T1').map((run) => run.role), ['developer', 'tester', 'reviewer', 'developer', 'tester', 'reviewer']);
  for (const run of runs.filter((candidate) => candidate.task_id === 'T1')) {
    const result = JSON.parse(run.result_json);
    assert.equal(result?.result?.toolExecuted, true, `${run.role} attempt ${run.attempt} must complete only after an OpenClaw tool result`);
  }

  assert.equal(readFileSync(join(workspace, 'health.txt'), 'utf8'), 'status=healthy\ncycle=2\n');
  const expectedToolCalls = [
    'role=tech_lead cycle=0 tool=read',
    'role=developer cycle=1 tool=write',
    'role=tester cycle=1 tool=read',
    'role=reviewer cycle=1 tool=read',
    'role=developer cycle=2 tool=write',
    'role=tester cycle=2 tool=read',
    'role=reviewer cycle=2 tool=read',
  ];
  await waitFor(() => expectedToolCalls.every((expected) => providerLog.includes(`ARIAD_FAKE_TOOL_CALL ${expected}`)), 'fake-provider tool trace flush', 5000);

  const finalCommit = git(workspace, ['rev-parse', 'HEAD']);
  assert.notEqual(finalCommit, seedCommit);
  assert.equal(git(workspace, ['status', '--porcelain']), '');
  assert.equal(git(workspace, ['rev-list', '--count', 'HEAD']), '2');
  assert.match(git(workspace, ['log', '-1', '--pretty=%s']), /^Ariad: T1 \(strategy 1, cycle 2\)$/);
  assert.equal(git(workspace, ['remote']), '', 'CI fixture intentionally has no remote, proving no push was attempted');

  console.log('ARIAD_OPENCLAW_TL_TASK_MATERIALIZATION_E2E_OK');
} finally {
  gateway.kill('SIGTERM');
  provider.kill('SIGTERM');
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  rmSync(root, { recursive: true, force: true });
}
