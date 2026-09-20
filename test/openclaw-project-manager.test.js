import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AriadProjectManager, slugify } from '../extensions/openclaw-ariad/runtime/project-manager.js';
import { AriadDashboardService } from '../extensions/openclaw-ariad/src/dashboard-service.ts';

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
    const takeover = manager.create('Takeover Project', {
      goal: 'assess existing repo',
      mode: 'TAKEOVER',
      sourcePath: join(dir, 'existing-repo'),
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
    assert.equal(takeover.mode, 'TAKEOVER');
    assert.equal(takeover.sourcePath, join(dir, 'existing-repo'));

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

test('OpenClaw plugin manifest owns exactly one Ariad tool and starts with Gateway', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/openclaw-ariad/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'ariad');
  assert.deepEqual(manifest.contracts.tools, ['ariad_project']);
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
