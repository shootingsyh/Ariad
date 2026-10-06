import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { ensureInterfaceArtifactLayout } from '../src/v2/interface-contracts.js';
import { reconcileMigratedDeliveryTasks } from '../src/v2/migration-reconciler.js';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function executor(id) {
  return {
    id,
    kind: 'executor',
    visibility: 'exported',
    contract: { input: [], output: [id], sideEffects: [] },
  };
}

test('migration reconciler adopts resolvable feature work and sends uncertain work back to developer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-migration-reconcile-'));
  try {
    const workspace = path.join(root, 'workspace');
    const artifactRoot = path.join(workspace, '.ariad', 'artifacts');
    fs.mkdirSync(path.join(workspace, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'scripts', 'entry.gd'), 'func new_game():\n  return true\n');

    const layout = ensureInterfaceArtifactLayout(artifactRoot);
    fs.mkdirSync(path.join(artifactRoot, 'planner', 'logical'), { recursive: true });
    writeJson(path.join(artifactRoot, 'planner', 'logical', 'entry.json'), {
      id: 'entry', title: 'Entry', summary: 'Entry', parentId: null,
    });
    writeJson(path.join(layout.featureDir, 'entry.json'), {
      version: 1,
      nodeId: 'entry',
      nodeType: 'feature',
      decomposition: { kind: 'leaf', reason: 'entry boundary' },
      interfaces: [executor('new-game'), executor('continue-game')],
      imports: [],
      integrationScenarios: [],
      bindings: [{
        interfaceId: 'new-game',
        realizationAnchors: [{ kind: 'symbol', file: 'scripts/entry.gd', symbol: 'new_game', status: 'DIRTY' }],
        verificationAnchors: [],
      }],
      featureTasks: [
        {
          id: 'existing',
          title: 'Existing',
          intent: 'Use current implementation',
          acceptanceCriteria: ['works'],
          testStrategy: 'verify',
          verification: [],
          interfaceIds: ['new-game'],
        },
        {
          id: 'missing',
          title: 'Missing',
          intent: 'Needs implementation',
          acceptanceCriteria: ['works'],
          testStrategy: 'verify',
          verification: [],
          interfaceIds: ['continue-game'],
        },
      ],
    });

    const db = path.join(root, 'state.db');
    const store = new SQLiteV2Store(db);
    store.createProject({
      id: 'demo',
      workspace,
      planningModelMigration: { status: 'REBUILDING', fromVersion: 1, toVersion: 2 },
    });
    store.createTask({
      id: 'existing', projectId: 'demo', stage: 'developer', state: 'READY',
      taskKind: 'feature', ownerFeatureId: 'entry', logicalRefs: ['entry'], interfaceIds: ['new-game'],
    });
    store.createTask({
      id: 'missing', projectId: 'demo', stage: 'developer', state: 'READY',
      taskKind: 'feature', ownerFeatureId: 'entry', logicalRefs: ['entry'], interfaceIds: ['continue-game'],
    });
    store.createTask({
      id: 'integration', projectId: 'demo', stage: 'developer', state: 'READY',
      taskKind: 'integration', ownerMilestoneId: 'M1', interfaceIds: [],
    });

    const results = reconcileMigratedDeliveryTasks({
      store, projectId: 'demo', artifactRoot, workspace,
      at: '2026-10-04T18:00:00.000Z',
    });

    assert.equal(store.getTask('existing').stage, 'tester');
    assert.equal(store.getTask('missing').stage, 'developer');
    assert.equal(store.getTask('integration').stage, 'tester');
    assert.equal(results.find(x => x.taskId === 'existing').decision, 'ADOPT_EXISTING_IMPLEMENTATION');
    assert.equal(results.find(x => x.taskId === 'missing').decision, 'REIMPLEMENT_OR_REBIND');
    assert.equal(results.find(x => x.taskId === 'integration').decision, 'VERIFY_EXISTING_INTEGRATION');
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
