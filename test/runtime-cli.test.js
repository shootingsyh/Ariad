import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { runAriadCli } from '../src/runtime/cli.js';

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
