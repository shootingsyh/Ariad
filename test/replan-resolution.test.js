import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { VersionedTaskStore } from '../src/v2/versioned-task-store.js';
import { promoteVersionedDraft } from '../src/v2/versioned-promotion.js';
import { resolveReplannedTasks } from '../src/v2/replan-resolution.js';

// Unit: the resolver over a minimal store double.
function fakeStore(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  return {
    byId,
    getTask(id) { return byId.get(id) ?? null; },
    appendTaskHistory(id, version, entry, patch = {}) {
      const task = byId.get(id);
      assert.equal(task.version, version);
      Object.assign(task, patch);
      task.history = [...(task.history ?? []), entry];
      task.version += 1;
      return task;
    },
  };
}
const replanReq = (taskId) => ({ batchId: 'b1', request: { purpose: 'REPLAN_TASK', taskId } });
const parked = (extra = {}) => ({
  id: 'T', projectId: 'P', state: 'WAITING_REPLAN', stage: 'developer', version: 3, history: [], ...extra,
});

test('resolver resumes a parked task whose spec survived the split', () => {
  const store = fakeStore([parked()]);
  const resolved = resolveReplannedTasks(store, 'P', [replanReq('T')]);
  assert.deepEqual(resolved, [{ taskId: 'T', disposition: 'RESUMED' }]);
  const task = store.byId.get('T');
  assert.equal(task.state, 'READY');
  assert.equal(task.execution, null);
  assert.equal(task.history.at(-1).type, 'REPLAN_RESOLVED');
  assert.equal(task.history.at(-1).disposition, 'RESUMED');
  // Idempotent: a second settle is a no-op.
  assert.deepEqual(resolveReplannedTasks(store, 'P', [replanReq('T')]), []);
});

test('resolver obsoletes a parked task the split replaced', () => {
  const route = { type: 'DEBUGGER_ROUTE', role: 'project_debugger', route: 'tech_lead', diagnosis: 'TASK_TOO_LARGE' };
  const store = fakeStore([parked({ specMissing: true, history: [route] })]);
  const resolved = resolveReplannedTasks(store, 'P', [replanReq('T')]);
  assert.deepEqual(resolved, [{ taskId: 'T', disposition: 'SPLIT_REPLACED' }]);
  const task = store.byId.get('T');
  assert.equal(task.state, 'OBSOLETE');
  assert.equal(task.history.at(-1).disposition, 'SPLIT_REPLACED');
});

test('resolver leaves a spec-missing task without a park route untouched', () => {
  const store = fakeStore([parked({ id: 'C', specMissing: true })]);
  assert.deepEqual(resolveReplannedTasks(store, 'P', [replanReq('C')]), []);
  assert.equal(store.byId.get('C').history.length, 0);
});

test('resolver ignores non-parked tasks, other purposes and unknown ids', () => {
  const store = fakeStore([parked({ id: 'A', state: 'READY' }), parked({ id: 'B' })]);
  const resolved = resolveReplannedTasks(store, 'P', [
    replanReq('A'),
    { batchId: 'b1', request: { purpose: 'TRIAGE_AND_ASSIGN_ISSUE', taskId: 'B' } },
    replanReq('missing'),
    { batchId: 'b1', request: { purpose: 'REPLAN_TASK' } },
  ]);
  assert.deepEqual(resolved, []);
  assert.equal(store.byId.get('A').state, 'READY');
  assert.equal(store.byId.get('B').state, 'WAITING_REPLAN');
});

// Integration: plain runtime store - batch completion settles the park.
test('completePlanningBatch resolves a parked delivery task (plain store)', () => {
  const store = new SQLiteV2Store(':memory:');
  store.createProject({ id: 'P' });
  store.createTask({
    taskKind: 'FEATURE_TASK', id: 'T', projectId: 'P', scope: 'delivery',
    stage: 'developer', state: 'WAITING_REPLAN', history: [],
  });
  store.enqueuePlanningRequest({
    id: 'debugger-replan:T:1', projectId: 'P',
    request: { purpose: 'REPLAN_TASK', taskId: 'T', diagnosis: { outcome: 'TASK_TOO_LARGE' } },
  });
  store.createPlanningBatch({
    projectId: 'P', batchId: 'b1', requestIds: ['debugger-replan:T:1'],
    tasks: [{ id: 'planner:b1:pm-review', stage: 'pm' }],
  });
  const batch = store.completePlanningBatch('P', 'b1');
  assert.equal(batch[0].state, 'PLANNED');
  const task = store.getTask('T');
  assert.equal(task.state, 'READY');
  assert.equal(task.history.at(-1).type, 'REPLAN_RESOLVED');
  assert.equal(task.history.at(-1).disposition, 'RESUMED');
});

// Integration: versioned facade - the SRPG shape.
const CONTRACT = {
  id: 'feature.alpha', nodeType: 'feature',
  exportedInterfaces: [{ id: 'alpha_api' }],
  behavior: ['Alpha must charge before it can fire.'],
};
const M = { id: 'm-1', taskKind: 'MILESTONE_TASK', title: 'Milestone one', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' };
const F = { id: 'f-1', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Oversized task', parentId: 'm-1', dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };
const F2 = { id: 'f-2', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Split successor', parentId: 'm-1', dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };

function makeFacade(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-replan-'));
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

function parkAndClaim(facade, batchId) {
  const current = facade.getTask('f-1');
  facade.appendTaskHistory('f-1', current.version, {
    type: 'DEBUGGER_ROUTE', role: 'project_debugger', route: 'tech_lead', diagnosis: 'TASK_TOO_LARGE', at: new Date().toISOString(),
  }, { state: 'WAITING_REPLAN', stage: 'developer', execution: null });
  assert.equal(facade.getTask('f-1').state, 'WAITING_REPLAN');
  facade.enqueuePlanningRequest({
    id: `debugger-replan:f-1:${batchId}`, projectId: 'proj',
    request: { purpose: 'REPLAN_TASK', taskId: 'f-1', diagnosis: { outcome: 'TASK_TOO_LARGE', splitProposal: [] } },
  });
  facade.createPlanningBatch({
    projectId: 'proj', batchId, requestIds: [`debugger-replan:f-1:${batchId}`],
    tasks: [{ id: `planner:${batchId}:pm-review`, stage: 'pm' }],
  });
}

test('facade: task kept by the split resumes when its batch completes', (t) => {
  const { seed, facade } = makeFacade(t);
  seedAndPromote(seed);
  parkAndClaim(facade, 'batch-keep');
  facade.completePlanningBatch('proj', 'batch-keep');
  const task = facade.getTask('f-1');
  assert.equal(task.state, 'READY');
  assert.equal(task.history.at(-1).type, 'REPLAN_RESOLVED');
  assert.equal(task.history.at(-1).disposition, 'RESUMED');
});

test('facade: task replaced by the split is obsoleted and the successor is schedulable', (t) => {
  const { seed, facade } = makeFacade(t);
  seedAndPromote(seed);
  parkAndClaim(facade, 'batch-split');
  // TL split lands: f-1 removed, successor f-2 created.
  seed.createDraft({ createdBy: 'tl' });
  seed.applyTreeOps([
    { op: 'removeTask', taskId: 'f-1' },
    { op: 'upsertTask', task: F2 },
  ]);
  promoteVersionedDraft({ versionedStore: seed, approvedBy: 'pm' });
  assert.equal(facade.getTask('f-1').specMissing, true);
  facade.completePlanningBatch('proj', 'batch-split');
  const replaced = facade.getTask('f-1');
  assert.equal(replaced.state, 'OBSOLETE');
  assert.equal(replaced.history.at(-1).type, 'REPLAN_RESOLVED');
  assert.equal(replaced.history.at(-1).disposition, 'SPLIT_REPLACED');
  assert.equal(facade.getTask('f-2').state, 'READY');
});
