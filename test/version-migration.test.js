import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import {
  completePlanningModelMigration,
  migratePlanningModelDatabase,
  restorePlanningArtifactBundle,
  validatePlanningArtifactBundleManifest,
} from '../src/v2/version-migration.js';
import { CURRENT_PLANNING_MODEL_VERSION } from '../src/v2/schema-version.js';

test('planning model migration archives the whole old DB and starts from a fresh control plane', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-version-migration-'));
  const workspace = path.join(root, 'workspace');
  const ariad = path.join(workspace, '.ariad');
  const artifactRoot = path.join(ariad, 'artifacts');
  const stateDb = path.join(ariad, 'state.db');
  fs.mkdirSync(path.join(artifactRoot, 'planner', 'logical'), { recursive: true });
  fs.writeFileSync(
    path.join(artifactRoot, 'planner', 'logical', 'legacy.json'),
    JSON.stringify({ id: 'legacy' }),
  );

  const old = new SQLiteV2Store(stateDb);
  old.createProject({
    id: 'demo',
    spec: 'preserve the product',
    mode: 'TAKEOVER',
    sourcePath: workspace,
    workspace,
    pmBinding: 'pm:demo',
    deliveryEnabled: true,
    takeoverReviewRequired: false,
    projectVersion: 4,
    activeVersion: 5,
    versionHistory: [{ version: 4 }],
    storageVersion: 1,
    planningModelVersion: 1,
  });
  old.createTask({
    id: 'OLD-TASK',
    projectId: 'demo',
    state: 'DONE',
    history: [{
      type: 'HUMAN_DECISION',
      decision: 'preserve existing behavior',
      at: '2026-10-04T00:00:00.000Z',
    }],
  });
  old.enqueuePlanningRequest({
    id: 'legacy-plan',
    projectId: 'demo',
    request: { purpose: 'OLD_REPLAN' },
  });
  old.close();

  const migration = migratePlanningModelDatabase({
    stateDb,
    projectId: 'demo',
    artifactRoot,
    now: () => new Date('2026-10-04T12:00:00.000Z'),
  });

  assert.equal(migration.status, 'REBUILDING');
  assert.equal(migration.fromVersion, 1);
  assert.equal(migration.toVersion, CURRENT_PLANNING_MODEL_VERSION);
  assert.equal(fs.existsSync(migration.legacyDatabasePath), true);
  assert.equal(fs.existsSync(migration.snapshotPath), true);
  assert.equal(fs.existsSync(migration.legacyPlannerPath), true);
  assert.equal(fs.existsSync(migration.artifactBundleManifestPath), true);
  const bundle = JSON.parse(fs.readFileSync(migration.artifactBundleManifestPath, 'utf8'));
  assert.equal(bundle.bundleId, migration.artifactBundleId);
  assert.equal(bundle.tuple.projectVersion, 4);
  assert.equal(bundle.tuple.activeVersion, 5);
  assert.equal(validatePlanningArtifactBundleManifest(bundle).ok, true);
  assert.equal(fs.existsSync(path.join(migration.legacyRevisionRoot, 'planner', 'logical', 'legacy.json')), true);

  const archived = new SQLiteV2Store(migration.legacyDatabasePath);
  assert.equal(archived.getTask('OLD-TASK')?.state, 'DONE');
  archived.close();

  const fresh = new SQLiteV2Store(stateDb);
  const project = fresh.getProject('demo');
  assert.equal(project.planningModelVersion, 1);
  assert.equal(project.planningModelMigration.status, 'REBUILDING');
  assert.equal(project.deliveryEnabled, false);
  assert.deepEqual(fresh.listTasks('demo'), []);

  const requests = fresh.listPlanningRequests('demo');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.purpose, 'VERSION_MIGRATION');
  assert.equal(requests[0].context.humanDecisions[0].decision, 'preserve existing behavior');
  assert.equal(requests[0].context.legacyRevisionRoot, migration.legacyRevisionRoot);

  completePlanningModelMigration(fresh, 'demo');
  assert.equal(fresh.getProject('demo').planningModelVersion, CURRENT_PLANNING_MODEL_VERSION);
  assert.equal(fresh.getProject('demo').planningModelMigration.status, 'COMPLETED');
  fresh.close();

  fs.rmSync(root, { recursive: true, force: true });
});


test('planning artifact bundle restore archives partial control plane and restores aligned DB + planner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-version-restore-'));
  const workspace = path.join(root, 'workspace');
  const ariad = path.join(workspace, '.ariad');
  const artifactRoot = path.join(ariad, 'artifacts');
  const stateDb = path.join(ariad, 'state.db');
  fs.mkdirSync(path.join(artifactRoot, 'planner', 'logical'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'planner', 'logical', 'root.json'), JSON.stringify({ id: 'root' }));

  const store = new SQLiteV2Store(stateDb);
  store.createProject({
    id: 'restore-demo',
    projectVersion: 2,
    activeVersion: 3,
    deliveryPlanVersion: 9,
    logicalNodes: [{ id: 'root', parentId: null }],
    milestones: [],
    storageVersion: 1,
    planningModelVersion: 1,
  });
  store.close();

  const migration = migratePlanningModelDatabase({
    stateDb,
    projectId: 'restore-demo',
    artifactRoot,
    now: () => new Date('2026-10-04T12:00:00.000Z'),
  });

  const partial = new SQLiteV2Store(stateDb);
  partial.updateProject('restore-demo', partial.getProject('restore-demo').version, { projectVersion: 99 });
  partial.close();
  fs.mkdirSync(path.join(artifactRoot, 'planner', 'logical'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'planner', 'logical', 'partial.json'), JSON.stringify({ id: 'partial' }));

  const restored = restorePlanningArtifactBundle({
    stateDb,
    artifactRoot,
    bundleManifestPath: migration.artifactBundleManifestPath,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
  });
  assert.equal(restored.tuple.projectVersion, 2);
  assert.equal(fs.existsSync(path.join(restored.abandonedPath, 'state.db')), true);
  assert.equal(fs.existsSync(path.join(restored.abandonedPath, 'planner', 'logical', 'partial.json')), true);
  assert.equal(fs.existsSync(path.join(artifactRoot, 'planner', 'logical', 'root.json')), true);
  assert.equal(fs.existsSync(path.join(artifactRoot, 'planner', 'logical', 'partial.json')), false);

  const check = new SQLiteV2Store(stateDb);
  assert.equal(check.getProject('restore-demo').projectVersion, 2);
  assert.equal(check.getProject('restore-demo').deliveryPlanVersion, 9);
  check.close();
  fs.rmSync(root, { recursive: true, force: true });
});
