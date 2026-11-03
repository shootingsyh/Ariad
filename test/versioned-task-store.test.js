import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { VersionedTaskStore } from '../src/v2/versioned-task-store.js';
import { promoteVersionedDraft } from '../src/v2/versioned-promotion.js';

const CONTRACT = {
  id: 'feature.alpha', nodeType: 'feature',
  exportedInterfaces: [{ id: 'alpha_api' }],
  behavior: ['Alpha must charge before it can fire.'],
};
const M = { id: 'm-1', taskKind: 'MILESTONE_TASK', title: 'Milestone one', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' };
const F = { id: 'f-1', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Feature leaf', parentId: 'm-1', dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };

function makeFacade(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-vts-'));
  const file = join(dir, 'state.db');
  const runtime = new SQLiteV2Store(file);
  runtime.createProject({ id: 'proj', name: 'P', versionedTree: true });
  const seed = new VersionedStore(file);
  seed.initProject('proj');
  const facade = new VersionedTaskStore(runtime);
  t.after(() => { facade.close(); seed.close(); runtime.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, seed, facade };
}

function seedAndPromote(seed) {
  seed.createDraft({ createdBy: 'tl' });
  seed.applyTreeOps([
    { op: 'upsertContract', contract: CONTRACT },
    { op: 'upsertTask', task: M },
    { op: 'upsertTask', task: F },
  ]);
  promoteVersionedDraft({ versionedStore: seed, approvedBy: 'pm' });
}

test('facade serves the prod task tree without runtime copies', (t) => {
  const { runtime, seed, facade } = makeFacade(t);
  seedAndPromote(seed);
  assert.equal(runtime.listTasks('proj', { scope: 'delivery' }).length, 0);
  const delivery = facade.listTasks('proj', { scope: 'delivery' });
  assert.deepEqual(delivery.map(x => x.id).sort(), ['f-1', 'm-1']);
  const leaf = facade.getTask('f-1');
  assert.equal(leaf.title, 'Feature leaf');
  assert.equal(leaf.state, 'READY');
  assert.equal(leaf.milestoneId, 'm-1');
  assert.equal(facade.getTask('m-1').milestoneId, 'm-1');
});

test('facade writes land in the exec record, respect versions, and cannot rewrite spec fields', (t) => {
  const { runtime, seed, facade } = makeFacade(t);
  seedAndPromote(seed);
  const leaf = facade.getTask('f-1');
  const updated = facade.updateTask('f-1', leaf.version, { state: 'WORKING', stage: 'developer', title: 'HACKED', parentId: 'nope' });
  assert.equal(updated.state, 'WORKING');
  assert.equal(updated.stage, 'developer');
  assert.equal(updated.title, 'Feature leaf');
  assert.equal(updated.parentId, 'm-1');
  assert.equal(updated.version, leaf.version + 1);
  assert.throws(() => facade.updateTask('f-1', leaf.version, { state: 'DONE' }), /task version conflict: f-1/);
  const withHistory = facade.appendTaskHistory('f-1', updated.version, { type: 'NOTE', text: 'hi' });
  assert.equal(withHistory.history.length, 1);
  assert.equal(withHistory.history[0].type, 'NOTE');
  assert.equal(runtime.getTask('f-1'), null);
});

test('control tasks stay runtime-side; runtime-born delivery tasks become embedded exec tasks', (t) => {
  const { runtime, seed, facade } = makeFacade(t);
  seedAndPromote(seed);
  facade.createControlFlow({ projectId: 'proj', flowId: 'batch-1', tasks: [{ id: 'plan-1', stage: 'pm', state: 'READY', title: 'Plan', input: { purpose: 'X' } }] });
  assert.ok(runtime.getTask('plan-1'));
  assert.equal(facade.getTask('plan-1').title, 'Plan');
  facade.createTask({ id: 'fix-1', projectId: 'proj', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', stage: 'developer', state: 'READY', title: 'Runtime fix', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' });
  assert.equal(runtime.getTask('fix-1'), null);
  assert.equal(facade.getTask('fix-1').title, 'Runtime fix');
  assert.ok(facade.listTasks('proj', { scope: 'delivery' }).some(x => x.id === 'fix-1'));
  assert.ok(facade.listTasks('proj', { scope: 'control' }).some(x => x.id === 'plan-1'));
});

test('a second promotion keeps exec state; nothing is ever copied into the runtime table', (t) => {
  const { runtime, seed, facade } = makeFacade(t);
  seedAndPromote(seed);
  const leaf = facade.getTask('f-1');
  facade.updateTask('f-1', leaf.version, { state: 'DONE', stage: 'reviewer' });
  seed.createDraft({ createdBy: 'tl' });
  seed.applyTreeOps([{ op: 'upsertTask', task: { ...F, title: 'Feature leaf renamed' } }]);
  promoteVersionedDraft({ versionedStore: seed, approvedBy: 'pm' });
  const after = facade.getTask('f-1');
  assert.equal(after.state, 'DONE');
  assert.equal(after.title, 'Feature leaf renamed');
  assert.equal(runtime.listTasks('proj', { scope: 'delivery' }).length, 0);
});

test('standalone runtime wraps versioned projects in the facade and sees the prod task tree', async (t) => {
  const { StandaloneProjectRuntime } = await import('../src/runtime/standalone-project-runtime.js');
  const dir = mkdtempSync(join(tmpdir(), 'ariad-vts-rt-'));
  const file = join(dir, 'state.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seedRuntime = new SQLiteV2Store(file);
  seedRuntime.createProject({ id: 'proj', name: 'P', versionedTree: true, workspace: dir });
  seedRuntime.db.close();
  const seed = new VersionedStore(file);
  seed.initProject('proj');
  seed.createDraft({ createdBy: 'tl' });
  seed.applyTreeOps([
    { op: 'upsertContract', contract: CONTRACT },
    { op: 'upsertTask', task: M },
    { op: 'upsertTask', task: F },
  ]);
  promoteVersionedDraft({ versionedStore: seed, approvedBy: 'pm' });
  seed.close();

  const runtime = new StandaloneProjectRuntime({
    project: { id: 'proj', workspace: dir, stateDb: file },
    provider: { id: 'fake', start: async () => {}, poll: async () => {}, cancel: async () => {} },
    resolveRoleModel: () => null,
  });
  assert.ok(runtime.store instanceof VersionedTaskStore);
  const delivery = runtime.store.listTasks('proj', { scope: 'delivery' });
  assert.deepEqual(delivery.map(x => x.id).sort(), ['f-1', 'm-1']);
  assert.equal(runtime.store.getTask('f-1').milestoneId, 'm-1');
});

test('facade routes triaged fixes into the issue queue and resolves the issue on completion', (t) => {
  const { runtime, seed, facade } = makeFacade(t);
  seedAndPromote(seed);
  const issue = runtime.createIssue({ projectId: 'proj', title: 'Crash on save', description: 'Boom' });
  const fix = facade.insertTriagedFixTask({
    projectId: 'proj', issueId: issue.id, actor: 'tech_lead',
    task: { id: 'fix-1', taskKind: 'FEATURE_TASK', title: 'Fix crash', dependsOn: [] },
    beforeTaskIds: ['f-1'],
  });
  assert.equal(fix.queue, 'issue');
  assert.equal(fix.milestoneId, null);
  // The fix is an embedded queue item on the versioned side: no runtime
  // row, and the prod spec (the task tree) is untouched.
  assert.equal(runtime.getTask('fix-1'), null);
  assert.deepEqual(seed.listSpecTasks(1).map(x => x.id).sort(), ['f-1', 'm-1']);
  assert.equal(runtime.getIssue(issue.id).state, 'ASSIGNED');
  const live = facade.getTask('fix-1');
  facade.updateTask('fix-1', live.version, { state: 'DONE', stage: 'reviewer' });
  assert.deepEqual(facade.reconcileAssignedIssues('proj'), [issue.id]);
  assert.equal(runtime.getIssue(issue.id).state, 'RESOLVED');
});
