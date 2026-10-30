import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import {
  compileUnifiedTaskTree, reconcileUnifiedTaskTree, verifyUnifiedCompilerAgainstStore,
} from '../src/v2/unified-task-compiler.js';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function baseContract(nodeId, nodeType, extra = {}) {
  return {
    version: 1, nodeId, nodeType,
    decomposition: { kind: 'leaf', reason: 'bounded scope' },
    interfaces: [], imports: [], featureUses: [], integrationScenarios: [],
    bindings: [], featureTasks: [], taskLinks: [], integrationTasks: [],
    ...extra,
  };
}

function featureTask(id, extra = {}) {
  return {
    id, title: `Task ${id}`, intent: `Do ${id}.`, acceptanceCriteria: [`${id} done.`],
    testStrategy: 'Tests.', interfaceIds: [], ...extra,
  };
}

function docTask(id, extra = {}) {
  return {
    id, title: `Task ${id}`, intent: `Do ${id}.`, dependsOn: [], logicalRefs: ['game'],
    acceptanceCriteria: [`${id} done.`], testStrategy: 'Tests.', ...extra,
  };
}

// Minimal unified artifact tree: one milestone M1, one feature task T1, and
// the milestone integration entry m1-e2e. Options evolve the plan to v2.
function buildArtifacts(dir, { withT2 = false, t1Intent = null, t1DependsOnT2 = false } = {}) {
  const artifactRoot = path.join(dir, 'artifacts');
  const planner = path.join(artifactRoot, 'planner');
  writeJson(path.join(planner, 'logical', 'game.json'),
    { id: 'game', title: 'Game', summary: 'Complete game', parentId: null });
  const featureTasks = [featureTask('T1', t1Intent ? { intent: t1Intent } : {})];
  if (withT2) featureTasks.push(featureTask('T2', { issueRefs: ['issue:T2'] }));
  writeJson(path.join(planner, 'interfaces', 'features', 'game.json'),
    baseContract('game', 'feature', { featureTasks }));
  const docTasks = [docTask('m1-e2e', { title: 'M1 integration' }), docTask('T1')];
  if (withT2) docTasks.push(docTask('T2'));
  writeJson(path.join(planner, 'milestones', 'M1.json'), {
    id: 'M1', title: 'Slice', goal: 'Deliver the slice.', parentId: null,
    dependsOn: [], logicalRefs: ['game'],
    acceptanceCriteria: ['Slice works.'], testStrategy: 'E2E.', tasks: docTasks,
  });
  const taskLinks = [{ taskId: 'T1', addDependsOn: t1DependsOnT2 ? ['T2'] : [], addVerification: [] }];
  if (withT2) taskLinks.push({ taskId: 'T2', addDependsOn: [], addVerification: [] });
  writeJson(path.join(planner, 'interfaces', 'milestones', 'M1.json'),
    baseContract('M1', 'milestone', {
      integrationTasks: [{
        id: 'm1-e2e', title: 'M1 integration', intent: 'Prove the slice.',
        acceptanceCriteria: ['Slice proven.'], testStrategy: 'E2E.',
        verification: [],
      }],
      taskLinks,
    }));
  return artifactRoot;
}

function seedUnifiedProject(dir, artifactRoot, projectExtra = {}) {
  const store = new SQLiteV2Store(path.join(dir, 'state.db'));
  store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: true, unifiedTaskCompilerVersion: 1, ...projectExtra });
  for (const spec of compileUnifiedTaskTree(artifactRoot).tasks) {
    store.createTask({ ...spec, projectId: 'P', state: 'READY', stage: 'developer' });
  }
  return store;
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-unified-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifactRoot = buildArtifacts(dir, options);
  const store = seedUnifiedProject(dir, artifactRoot);
  t.after(() => store.close());
  return { dir, artifactRoot, store };
}

test('reconcile lands new approved tasks and updates unfinished ones', (t) => {
  const { dir, artifactRoot, store } = fixture(t);
  buildArtifacts(dir, { withT2: true, t1DependsOnT2: true });
  const result = reconcileUnifiedTaskTree({ artifactRoot, store, projectId: 'P' });
  assert.deepEqual(result.created, ['T2']);
  assert.ok(result.updated.includes('T1'), 'T1 takes the new dependency');
  assert.ok(result.updated.includes('M1'), 'aggregate gains the new child dependency');
  const t2 = store.getTask('T2');
  assert.equal(t2.state, 'READY');
  assert.equal(t2.unifiedTaskSchemaVersion, 1);
  assert.deepEqual(t2.issueRefs, ['issue:T2']);
  assert.deepEqual(store.getTask('T1').dependsOn, ['T2']);
  assert.equal(verifyUnifiedCompilerAgainstStore({ artifactRoot, store, projectId: 'P' }).ok, true);
});

test('reconcile is a no-op when the store already matches the plan', (t) => {
  const { artifactRoot, store } = fixture(t);
  const result = reconcileUnifiedTaskTree({ artifactRoot, store, projectId: 'P' });
  assert.deepEqual(result, { created: [], updated: [], obsoleted: [], total: 2 });
});

test('reconcile refuses to revise a DONE task and writes nothing', (t) => {
  const { dir, artifactRoot, store } = fixture(t);
  const t1 = store.getTask('T1');
  store.updateTask('T1', t1.version, { state: 'DONE', history: [{ type: 'ROLE_RESULT', role: 'reviewer', outcome: 'PASS' }] });
  buildArtifacts(dir, { withT2: true, t1Intent: 'Changed semantics.' });
  assert.throws(
    () => reconcileUnifiedTaskTree({ artifactRoot, store, projectId: 'P' }),
    (error) => error.issues?.some((issue) => issue.reason === 'REVISE_COMPLETED_TASK'),
  );
  assert.equal(store.getTask('T2'), null);
  assert.equal(store.getTask('T1').intent, 'Do T1.');
});

test('reconcile defers when a changed task is in flight', (t) => {
  const { dir, artifactRoot, store } = fixture(t);
  const t1 = store.getTask('T1');
  store.updateTask('T1', t1.version, { state: 'WORKING', execution: { id: 'live' } });
  buildArtifacts(dir, { withT2: true, t1DependsOnT2: true });
  assert.throws(
    () => reconcileUnifiedTaskTree({ artifactRoot, store, projectId: 'P' }),
    (error) => error.code === 'UNIFIED_TASK_DELIVERY_IN_FLIGHT',
  );
  assert.equal(store.getTask('T2'), null);
  assert.deepEqual(store.getTask('T1').dependsOn, []);
});

test('reconcile obsoletes dropped unfinished tasks', (t) => {
  const { dir, artifactRoot, store } = fixture(t, { withT2: true });
  buildArtifacts(dir, {});
  const result = reconcileUnifiedTaskTree({ artifactRoot, store, projectId: 'P' });
  assert.deepEqual(result.obsoleted, ['T2']);
  assert.equal(store.getTask('T2').state, 'OBSOLETE');
});

test('reconcile refuses to drop a DONE task', (t) => {
  const { dir, artifactRoot, store } = fixture(t, { withT2: true });
  const t2 = store.getTask('T2');
  store.updateTask('T2', t2.version, { state: 'DONE' });
  buildArtifacts(dir, {});
  assert.throws(
    () => reconcileUnifiedTaskTree({ artifactRoot, store, projectId: 'P' }),
    (error) => error.issues?.some((issue) => issue.reason === 'REMOVE_COMPLETED_TASK'),
  );
  assert.equal(store.getTask('T2').state, 'DONE');
});

test('reconcile requires a prepared unified project', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-unified-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifactRoot = buildArtifacts(dir, {});
  const store = new SQLiteV2Store(path.join(dir, 'state.db'));
  t.after(() => store.close());
  store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: true });
  assert.throws(
    () => reconcileUnifiedTaskTree({ artifactRoot, store, projectId: 'P' }),
    /UNIFIED_TASK_COMPILER_NOT_PREPARED/,
  );
});
