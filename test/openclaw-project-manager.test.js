import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectExecutionCapabilities } from '../extensions/openclaw-ariad/runtime/execution-capabilities.js';
import { AriadProjectManager, slugify } from '../extensions/openclaw-ariad/runtime/project-manager.js';
import {
  ARIAD_MODEL_ROLES,
  requireCompleteRoleModels,
} from '../extensions/openclaw-ariad/runtime/role-models.js';
import { AriadDashboardService } from '../extensions/openclaw-ariad/src/dashboard-service.ts';


test('execution capability discovery detects Windows host interop under WSL', () => {
  const existing = new Set([
    '/mnt/c/Windows/System32/cmd.exe',
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/dev/dxg',
  ]);
  const capabilities = detectExecutionCapabilities({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    exists: path => existing.has(path),
    read: () => 'Linux version Microsoft WSL2',
  });
  assert.deepEqual(capabilities, [
    'cmd',
    'gpu',
    'linux.native',
    'powershell',
    'windows.host-via-wsl',
    'wsl',
  ]);
});

test('OpenClaw Ariad project manager isolates project folders and durable desired state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-openclaw-'));
  const manager = new AriadProjectManager({
    projectsRoot: join(dir, 'projects'),
    now: () => new Date('2026-09-16T12:00:00.000Z'),
  });

  try {
    const alpha = manager.create('Alpha Project', {
      goal: 'build alpha',
      frontdeskBinding: { host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:alpha' },
    });
    const beta = manager.create('Beta Project', { goal: 'build beta' });
    const existingRepo = join(dir, 'existing-repo');
    mkdirSync(join(existingRepo, '.git'), { recursive: true });
    writeFileSync(join(existingRepo, 'README.md'), '# existing\n');
    const takeover = manager.create('Takeover Project', {
      goal: 'assess existing repo',
      mode: 'TAKEOVER',
      sourcePath: existingRepo,
    });

    assert.equal(alpha.id, 'alpha-project');
    assert.equal(beta.id, 'beta-project');
    assert.notEqual(alpha.root, beta.root);
    assert.notEqual(alpha.workspace, beta.workspace);
    assert.notEqual(alpha.stateDb, beta.stateDb);
    assert.ok(existsSync(join(alpha.root, 'workspace')));
    assert.ok(existsSync(join(beta.root, 'workspace')));
    assert.equal(alpha.stateDb, join(alpha.workspace, '.ariad', 'state.db'));
    assert.equal(beta.stateDb, join(beta.workspace, '.ariad', 'state.db'));
    assert.ok(existsSync(join(alpha.workspace, '.ariad', 'project.json')));
    assert.ok(existsSync(join(beta.workspace, '.ariad', 'project.json')));
    assert.equal(alpha.desiredState, 'STOPPED');
    assert.equal(beta.desiredState, 'STOPPED');
    assert.equal(alpha.projectVersion, 0);
    assert.equal(alpha.activeVersion, 1);
    assert.equal(takeover.mode, 'TAKEOVER');
    assert.equal(takeover.sourcePath, existingRepo);
    assert.equal(takeover.workspace, existingRepo);
    assert.equal(takeover.stateDb, join(existingRepo, '.ariad', 'state.db'));
    assert.equal(takeover.adopted, true);
    assert.ok(existsSync(join(existingRepo, '.ariad', 'project.json')));
    assert.equal(existsSync(join(takeover.root, 'workspace')), false);

    manager.setDesiredState('alpha-project', 'RUNNING');
    assert.equal(manager.status('alpha-project').desiredState, 'RUNNING');
    manager.setDesiredState('alpha-project', 'PAUSED');
    assert.equal(manager.status('alpha-project').desiredState, 'PAUSED');
    manager.setDesiredState('alpha-project', 'RUNNING');
    assert.equal(manager.status('alpha-project').desiredState, 'RUNNING');
    assert.equal(manager.status('beta-project').desiredState, 'STOPPED');
    manager.setDesiredState('beta-project', 'RUNNING');
    manager.setDesiredState('alpha-project', 'STOPPED');
    assert.equal(manager.status('alpha-project').desiredState, 'STOPPED');
    assert.equal(manager.status('beta-project').desiredState, 'RUNNING', 'stopping one project must not affect another');

    const listed = manager.list();
    assert.deepEqual(listed.map((p) => p.id).sort(), ['alpha-project', 'beta-project', 'takeover-project']);
    assert.match(readFileSync(join(beta.workspace, '.ariad', 'project.json'), 'utf8'), /build beta/);
    assert.throws(() => manager.create('Bad Mode', { mode: 'RESTORE' }), /invalid project mode/);

    assert.deepEqual(manager.status('alpha-project').frontdeskBinding, {
      host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:alpha',
    });

    manager.bindFrontdesk('alpha-project', {
      host: 'openclaw', agentId: 'delegate', sessionKey: 'agent:delegate:alpha',
    });
    assert.deepEqual(manager.status('alpha-project').frontdeskBinding, {
      host: 'openclaw', agentId: 'delegate', sessionKey: 'agent:delegate:alpha',
    });
    assert.equal(manager.status('alpha-project').desiredState, 'STOPPED');
    manager.unbindFrontdesk('alpha-project');
    assert.equal(manager.status('alpha-project').frontdeskBinding, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('Ariad role model policy is durable and supports partial per-role updates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-openclaw-models-'));
  const manager = new AriadProjectManager({ projectsRoot: join(dir, 'projects') });
  try {
    const initial = Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'llamacpp/qwen3.8-27b']));
    const created = manager.create('Model Project', {
      goal: 'model routing',
      roleModels: initial,
    });
    assert.deepEqual(created.roleModels, initial);
    assert.deepEqual(requireCompleteRoleModels(created.roleModels), initial);

    const updated = manager.setRoleModels('model-project', {
      pm: 'muse/muse-code',
      project_debugger: 'openai-codex/gpt-5.6-codex',
    });
    assert.equal(updated.roleModels.pm, 'muse/muse-code');
    assert.equal(updated.roleModels.project_debugger, 'openai-codex/gpt-5.6-codex');
    assert.equal(updated.roleModels.developer, 'llamacpp/qwen3.8-27b');

    assert.throws(
      () => requireCompleteRoleModels({ developer: 'llamacpp/qwen3.8-27b' }),
      /missing:/,
    );
    assert.throws(
      () => manager.setRoleModels('model-project', { tester: 'qwen3.8-27b' }),
      /explicit provider\/model ref/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy host-side project state migrates into the workspace repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-openclaw-legacy-layout-'));
  const projectsRoot = join(dir, 'projects');
  const root = join(projectsRoot, 'legacy-layout');
  const workspace = join(root, 'workspace');
  const legacyAriad = join(root, '.ariad');
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(legacyAriad, { recursive: true });
    writeFileSync(join(root, 'project.json'), JSON.stringify({
      id: 'legacy-layout',
      name: 'Legacy Layout',
      goal: 'migrate me',
      workspace,
      stateDb: join(legacyAriad, 'state.db'),
      desiredState: 'STOPPED',
      executionState: 'IDLE',
    }));
    writeFileSync(join(legacyAriad, 'state.db'), 'legacy-db');
    const manager = new AriadProjectManager({ projectsRoot });
    const project = manager.status('legacy-layout');
    assert.equal(project.stateDb, join(workspace, '.ariad', 'state.db'));
    assert.ok(existsSync(join(workspace, '.ariad', 'project.json')));
    assert.ok(existsSync(join(workspace, '.ariad', 'state.db')));
    assert.equal(existsSync(join(root, 'project.json')), false);
    assert.equal(existsSync(join(root, '.ariad')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project ids cannot escape the configured projects root', () => {
  assert.equal(slugify('../My Project'), '..-my-project');
  assert.throws(() => slugify('..'), /letters or numbers/);
  assert.throws(() => slugify('---'), /letters or numbers/);
});

test('OpenClaw plugin manifest declares project and role-result tools and starts with Gateway', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/openclaw-ariad/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'ariad');
  assert.deepEqual(manifest.contracts.tools, [
    'ariad_project',
    'ariad_artist_result',
    'ariad_developer_result',
    'ariad_tester_result',
    'ariad_reviewer_result',
    'ariad_project_debugger_result',
    'ariad_tech_lead_result',
    'ariad_tech_lead_critic_result',
    'ariad_pm_result',
  ]);
  assert.equal(manifest.activation.onStartup, true);
});


test('legacy projectAgent binding is read as Frontdesk without migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-openclaw-legacy-frontdesk-'));
  const manager = new AriadProjectManager({ projectsRoot: join(dir, 'projects') });

  try {
    manager.create('Legacy Binding', {
      goal: 'compatibility',
      projectAgent: { host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:legacy' },
    });
    assert.deepEqual(manager.status('legacy-binding').frontdeskBinding, {
      host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:legacy',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('Ariad dashboard starts and serves project JSON without owning project state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-dashboard-'));
  const manager = new AriadProjectManager({ projectsRoot: join(dir, 'projects') });
  manager.create('Dashboard Project', { goal: 'observe me' });
  const dashboard = new AriadDashboardService({ manager, host: '127.0.0.1', port: 0 });

  try {
    await dashboard.start();
    const address = dashboard.address;
    assert.ok(address && typeof address.port === 'number' && address.port > 0);
    const projects = await fetch(`http://127.0.0.1:${address.port}/api/projects`).then(r => r.json());
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project.id, 'dashboard-project');
    assert.equal(projects[0].summary.total, 0);

    const page = await fetch(`http://127.0.0.1:${address.port}/`).then(r => r.text());
    assert.match(page, /Ariad Dashboard/);
    assert.match(page, /Read-only live view/);
  } finally {
    await dashboard.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('existing isolated takeover can adopt a real repo and move Ariad durable state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-adopt-existing-'));
  const projectsRoot = join(dir, 'projects');
  const manager = new AriadProjectManager({ projectsRoot });
  try {
    const project = manager.create('SRPG Takeover', {
      goal: 'reconstruct existing SRPG',
      mode: 'TAKEOVER',
    });
    const oldWorkspace = project.workspace;
    mkdirSync(join(oldWorkspace, '.ariad', 'docs'), { recursive: true });
    writeFileSync(join(oldWorkspace, '.ariad', 'docs', 'TAKEOVER.md'), 'reconstruction\n');
    writeFileSync(join(oldWorkspace, '.ariad', 'state.db'), 'sqlite-fixture');

    const target = join(dir, 'srpg-project');
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, 'project.godot'), '[application]\n');

    const adopted = manager.adopt('srpg-takeover', target);
    assert.equal(adopted.workspace, target);
    assert.equal(adopted.sourcePath, target);
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.mode, 'TAKEOVER');
    assert.equal(adopted.stateDb, join(target, '.ariad', 'state.db'));
    assert.equal(readFileSync(join(target, '.ariad', 'docs', 'TAKEOVER.md'), 'utf8'), 'reconstruction\n');
    assert.equal(readFileSync(join(target, '.ariad', 'state.db'), 'utf8'), 'sqlite-fixture');
    assert.equal(existsSync(oldWorkspace), false);
    assert.ok(existsSync(join(projectsRoot, 'srpg-takeover', 'project-ref.json')));

    manager.setDesiredState('srpg-takeover', 'RUNNING');
    assert.equal(manager.status('srpg-takeover').workspace, target);
    assert.equal(manager.status('srpg-takeover').desiredState, 'RUNNING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adopt refuses to hide product files created in the isolated workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-adopt-conflict-'));
  const manager = new AriadProjectManager({ projectsRoot: join(dir, 'projects') });
  try {
    const project = manager.create('Conflict Takeover', { mode: 'TAKEOVER' });
    writeFileSync(join(project.workspace, 'unexpected-code.txt'), 'do not lose me');

    const target = join(dir, 'real-repo');
    mkdirSync(join(target, '.git'), { recursive: true });

    assert.throws(
      () => manager.adopt('conflict-takeover', target),
      /contains product files outside \.ariad\/\.git/
    );
    assert.ok(existsSync(join(project.workspace, 'unexpected-code.txt')));
    assert.equal(existsSync(join(target, '.ariad', 'project.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('adopt can register an untracked existing repository as a TAKEOVER project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-adopt-register-'));
  const manager = new AriadProjectManager({ projectsRoot: join(dir, 'projects') });
  try {
    const target = join(dir, 'existing-repo');
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, 'README.md'), '# existing\n');

    assert.deepEqual(manager.list(), []);
    const adopted = manager.adopt('srpg', target);
    assert.equal(adopted.id, 'srpg');
    assert.equal(adopted.mode, 'TAKEOVER');
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.workspace, target);
    assert.equal(adopted.sourcePath, target);
    assert.ok(existsSync(join(target, '.ariad', 'project.json')));
    assert.ok(existsSync(join(dir, 'projects', 'srpg', 'project-ref.json')));
    assert.equal(manager.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
