import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { runAriadCli } from '../src/runtime/cli.js';
import { defaultProjectsRoot } from '../src/runtime/project-manager.js';

test('ariad project migrate archives the old DB and creates a fresh migration request', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-cli-migrate-'));
  try {
    const projectRoot = path.join(root, 'demo');
    const workspace = path.join(projectRoot, 'workspace');
    const ariad = path.join(workspace, '.ariad');
    const stateDb = path.join(ariad, 'state.db');
    fs.mkdirSync(path.join(ariad, 'artifacts', 'planner', 'logical'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(ariad, 'project.json'),
      JSON.stringify({
        id: 'demo',
        name: 'demo',
        workspace,
        stateDb,
        desiredState: 'STOPPED',
        executionState: 'IDLE',
        projectVersion: 0,
        activeVersion: 1,
        roleModels: {},
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(ariad, 'artifacts', 'planner', 'logical', 'legacy.json'),
      JSON.stringify({ id: 'legacy', title: 'Legacy', summary: 'Legacy', parentId: null }),
    );

    const old = new SQLiteV2Store(stateDb);
    old.createProject({
      id: 'demo',
      spec: 'demo',
      workspace,
      deliveryEnabled: false,
      planningModelVersion: 1,
      storageVersion: 1,
    });
    old.createTask({ id: 'old', projectId: 'demo', state: 'DONE' });
    old.close();

    const result = runAriadCli(['project', 'migrate', 'demo', '--projects-root', root]);
    assert.equal(result.migrated, true);
    assert.equal(fs.existsSync(result.migration.legacyDatabasePath), true);

    const fresh = new SQLiteV2Store(stateDb);
    assert.deepEqual(fresh.listTasks('demo'), []);
    const requests = fresh.listPlanningRequests('demo');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].request.purpose, 'VERSION_MIGRATION');
    fresh.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('ariad setup prepares global Pi provider auth without exposing credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-cli-setup-'));
  const original = process.env.ARIAD_PI_AUTH_PATH;
  process.env.ARIAD_PI_AUTH_PATH = path.join(root, 'auth.json');
  try {
    const result = runAriadCli(['setup']);
    assert.equal(result.action, 'setup');
    assert.equal(result.authPath, process.env.ARIAD_PI_AUTH_PATH);
    assert.equal(typeof result.providers['openai-codex'].ready, 'boolean');
    assert.equal(typeof result.providers.meta.ready, 'boolean');
    assert.equal(result.providers.llamacpp.ready, true);
    assert.equal('access' in result.providers['openai-codex'], false);
    assert.equal('key' in result.providers.meta, false);
  } finally {
    if (original === undefined) delete process.env.ARIAD_PI_AUTH_PATH;
    else process.env.ARIAD_PI_AUTH_PATH = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('standalone project root is default for new installs while legacy OpenClaw root remains discoverable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-project-root-'));
  try {
    assert.equal(defaultProjectsRoot(home), path.join(home, '.ariad', 'projects'));
    const legacy = path.join(home, '.openclaw', 'ariad', 'projects');
    fs.mkdirSync(legacy, { recursive: true });
    assert.equal(defaultProjectsRoot(home), legacy);
    const standalone = path.join(home, '.ariad', 'projects');
    fs.mkdirSync(standalone, { recursive: true });
    assert.equal(defaultProjectsRoot(home), standalone);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
