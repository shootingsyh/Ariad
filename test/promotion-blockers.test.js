import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionedStore } from '../src/v2/versioned-store.js';

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-pb-'));
  const store = new VersionedStore(join(dir, 'state.db'));
  store.initProject('proj');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const FEATURE_CONTRACT = {
  id: 'feature.alpha', nodeType: 'feature',
  exportedInterfaces: [{ id: 'alpha_api' }],
  behavior: ['Alpha must charge before it can fire.'],
};
const TASK_A = { id: 'a-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Alpha task', parentId: null, dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };
const TASK_B = { id: 'b-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Beta task', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' };
const TASK_C = { id: 'c-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Gamma task', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' };

function seedProtected(store) {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'upsertContract', contract: FEATURE_CONTRACT },
    { op: 'upsertTask', task: TASK_A },
    { op: 'upsertTask', task: TASK_B },
    { op: 'upsertTask', task: TASK_C },
  ]);
  store.promoteDraft({ approvedBy: 'pm' });
  store.upsertExecTask({ id: 'a-task', projectId: 'proj', state: 'DONE', stage: 'reviewer', history: [] });
  store.upsertExecTask({ id: 'b-task', projectId: 'proj', state: 'DONE', stage: 'reviewer', history: [] });
  store.upsertExecTask({ id: 'c-task', projectId: 'proj', state: 'WORKING', stage: 'developer', history: [] });
  store.upsertExecTask({ id: 'planner:batch-1', projectId: 'proj', state: 'WORKING', stage: 'tech_lead', history: [] }, { embedded: true });
}

function breakAllThree(store) {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'upsertTask', task: { ...TASK_A, executionMode: 'staged' } },
    { op: 'removeTask', taskId: 'b-task' },
    { op: 'upsertTask', task: { ...TASK_C, dependsOn: ['a-task'] } },
  ]);
}

test('protectedTasks lists frozen and in-flight exec tasks, skipping embedded', (t) => {
  const store = makeStore(t);
  seedProtected(store);
  const { frozen, inFlight } = store.protectedTasks();
  assert.deepEqual(frozen.map(x => x.id).sort(), ['a-task', 'b-task']);
  assert.ok(frozen.every(x => x.state === 'DONE'));
  assert.deepEqual(inFlight, [{ id: 'c-task', state: 'WORKING' }]);
});

test('diff exposes protectedTasks and every promotion blocker at once', (t) => {
  const store = makeStore(t);
  seedProtected(store);
  breakAllThree(store);
  const diff = store.diffDraft();
  assert.deepEqual(diff.protectedTasks.frozen.map(x => x.id).sort(), ['a-task', 'b-task']);
  assert.deepEqual(diff.protectedTasks.inFlight, [{ id: 'c-task', state: 'WORKING' }]);
  const blockers = Object.fromEntries(diff.promotionBlockers.map(b => [b.id, b]));
  assert.equal(diff.promotionBlockers.length, 3);
  assert.equal(blockers['a-task'].reason, 'gate-signature-changed');
  assert.equal(blockers['a-task'].code, 'REVISE_COMPLETED_TASK');
  assert.equal(blockers['b-task'].reason, 'removed');
  assert.equal(blockers['b-task'].code, 'PROMOTION_REMOVES_EXECUTED_TASK');
  assert.equal(blockers['c-task'].reason, 'gate-signature-changed');
  assert.equal(blockers['c-task'].code, 'UNIFIED_TASK_DELIVERY_IN_FLIGHT');
});

test('promote with several violations fails once, naming every task', (t) => {
  const store = makeStore(t);
  seedProtected(store);
  breakAllThree(store);
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => {
    assert.equal(e.code, 'PROMOTION_BLOCKED_BY_EXECUTED_WORK');
    for (const id of ['a-task', 'b-task', 'c-task']) assert.ok(e.message.includes(id), `message names ${id}`);
    assert.equal(e.details.violations.length, 3);
    return true;
  });
  // Fixing all blockers in one pass lets the same draft promote.
  store.applyTreeOps([
    { op: 'upsertTask', task: TASK_A },
    { op: 'upsertTask', task: TASK_B },
    { op: 'upsertTask', task: TASK_C },
  ]);
  assert.deepEqual(store.diffDraft().promotionBlockers, []);
  const res = store.promoteDraft({ approvedBy: 'pm' });
  assert.equal(store.getProdVersion(), res.version);
});

test('a single violation keeps its legacy code and gains the violations list', (t) => {
  const store = makeStore(t);
  seedProtected(store);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertTask', task: { ...TASK_A, executionMode: 'staged' } }]);
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => {
    assert.equal(e.code, 'REVISE_COMPLETED_TASK');
    assert.equal(e.details.taskId, 'a-task');
    assert.equal(e.details.violations.length, 1);
    assert.equal(e.details.violations[0].id, 'a-task');
    return true;
  });
});

const TASK_D = { id: 'd-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Delta task', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' };
const TASK_E = { id: 'e-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Epsilon task', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' };

function seedStarted(store) {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'upsertContract', contract: FEATURE_CONTRACT },
    { op: 'upsertTask', task: TASK_D },
    { op: 'upsertTask', task: TASK_E },
  ]);
  store.promoteDraft({ approvedBy: 'pm' });
  // d-task finished its developer stage and sits in READY for the next
  // stage: executed work, but neither frozen nor in flight (the SRPG
  // fix-cinematic shape).
  store.upsertExecTask({ id: 'd-task', projectId: 'proj', state: 'READY', stage: 'test_engineer', history: [{ type: 'ROLE_RESULT', role: 'developer', outcome: 'PASS' }] });
  // e-task has never started: dropping it is a legitimate plan change.
  store.upsertExecTask({ id: 'e-task', projectId: 'proj', state: 'READY', stage: 'developer', history: [] });
}

test('protectedTasks lists started tasks (READY with executed stages), not unstarted ones', (t) => {
  const store = makeStore(t);
  seedStarted(store);
  const { started } = store.protectedTasks();
  assert.deepEqual(started, [{ id: 'd-task', state: 'READY' }]);
});

test('promotion cannot drop a started task, but may drop an unstarted one', (t) => {
  const store = makeStore(t);
  seedStarted(store);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'removeTask', taskId: 'd-task' },
    { op: 'removeTask', taskId: 'e-task' },
  ]);
  const blockers = store.diffDraft().promotionBlockers;
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].id, 'd-task');
  assert.equal(blockers[0].reason, 'removed');
  assert.equal(blockers[0].code, 'PROMOTION_REMOVES_STARTED_TASK');
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => {
    assert.equal(e.code, 'PROMOTION_REMOVES_STARTED_TASK');
    assert.equal(e.details.taskId, 'd-task');
    return true;
  });
  // Restoring the started task lets the same draft promote; the
  // unstarted removal goes through.
  store.applyTreeOps([{ op: 'upsertTask', task: TASK_D }]);
  assert.deepEqual(store.diffDraft().promotionBlockers, []);
  const res = store.promoteDraft({ approvedBy: 'pm' });
  assert.equal(store.getProdVersion(), res.version);
});

test('promotion cannot change the gate signature of a started task', (t) => {
  const store = makeStore(t);
  seedStarted(store);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertTask', task: { ...TASK_D, dependsOn: ['e-task'] } }]);
  const blockers = store.diffDraft().promotionBlockers;
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].id, 'd-task');
  assert.equal(blockers[0].reason, 'gate-signature-changed');
  assert.equal(blockers[0].code, 'REVISE_STARTED_TASK');
});
