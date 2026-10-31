import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionedStore } from '../src/v2/versioned-store.js';

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-vs-'));
  const store = new VersionedStore(join(dir, 'state2.db'));
  store.initProject('proj');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const FEATURE_CONTRACT = {
  id: 'feature.alpha', nodeType: 'feature',
  exportedInterfaces: [{ id: 'alpha_api' }],
  behavior: ['Alpha must charge before it can fire.'],
};
const TASK_A = { id: 'a-task', taskKind: 'FEATURE_TASK', title: 'Alpha task', parentId: null, dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };
const TASK_B = { id: 'b-task', taskKind: 'FEATURE_TASK', title: 'Beta task', parentId: null, dependsOn: ['a-task'], interfaceIds: [], executionMode: 'direct' };

function seedV1(store) {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'upsertContract', contract: FEATURE_CONTRACT },
    { op: 'upsertTask', task: TASK_A },
    { op: 'upsertTask', task: TASK_B },
  ]);
  return store.promoteDraft({ approvedBy: 'pm' });
}

test('draft -> promote -> prod effective tasks are READY', (t) => {
  const store = makeStore(t);
  const { version, contentHash } = seedV1(store);
  assert.equal(version, 1);
  assert.ok(contentHash && contentHash.length === 64);
  assert.equal(store.getProdVersion(), 1);
  const tasks = store.effectiveTasks().filter(x => !x.specMissing);
  assert.deepEqual(tasks.map(x => x.id), ['a-task', 'b-task']);
  assert.ok(tasks.every(x => x.state === 'READY'));
  assert.equal(tasks[0].title, 'Alpha task');
});

test('draft edits are isolated until promotion; diff reports the change', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertTask', task: { ...TASK_A, title: 'Alpha task v2' } }]);
  const diff = store.diffDraft();
  assert.deepEqual(diff.tasks.changed, ['a-task']);
  assert.equal(store.getEffectiveTask('a-task').title, 'Alpha task');
  store.promoteDraft({ approvedBy: 'pm' });
  assert.equal(store.getProdVersion(), 2);
  assert.equal(store.getEffectiveTask('a-task').title, 'Alpha task v2');
});

test('invalid ops roll back the whole batch', (t) => {
  const store = makeStore(t);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertContract', contract: FEATURE_CONTRACT }, { op: 'upsertTask', task: TASK_A }]);
  assert.throws(
    () => store.applyTreeOps([
      { op: 'upsertTask', task: { ...TASK_B, dependsOn: ['b-task'] } },
    ]),
    (e) => e.code === 'TREE_VALIDATION_FAILED',
  );
  assert.equal(store.getSpecTask(1, 'b-task'), null);
  // cycle across two tasks also rejected
  assert.throws(
    () => store.applyTreeOps([
      { op: 'upsertTask', task: { id: 'x', taskKind: 'FEATURE_TASK', title: 'X', dependsOn: ['y'] } },
      { op: 'upsertTask', task: { id: 'y', taskKind: 'FEATURE_TASK', title: 'Y', dependsOn: ['x'] } },
    ]),
    (e) => e.code === 'TREE_VALIDATION_FAILED',
  );
});

test('behavior layer: leaf feature needs behavior; milestone must not carry it; scenarios need AC', (t) => {
  const store = makeStore(t);
  store.createDraft({ createdBy: 'tl' });
  assert.throws(
    () => store.applyTreeOps([{ op: 'upsertContract', contract: { id: 'feature.bare', nodeType: 'feature', exportedInterfaces: [] } }]),
    (e) => e.code === 'TREE_VALIDATION_FAILED',
  );
  assert.throws(
    () => store.applyTreeOps([{ op: 'upsertContract', contract: { id: 'ms.one', nodeType: 'milestone', behavior: ['nope'] } }]),
    (e) => e.code === 'TREE_VALIDATION_FAILED',
  );
  assert.throws(
    () => store.applyTreeOps([{ op: 'upsertContract', contract: { id: 'feature.parent', nodeType: 'feature', exportedInterfaces: [], integrationScenarios: [{ id: 's1' }] } }]),
    (e) => e.code === 'TREE_VALIDATION_FAILED',
  );
  const ok = store.applyTreeOps([{ op: 'upsertContract', contract: { id: 'feature.parent', nodeType: 'feature', exportedInterfaces: [], integrationScenarios: [{ id: 's1', acceptanceCriteria: ['parent holds'] }] } }]);
  assert.equal(ok.applied, 1);
});

test('promotion guards: DONE gate signature frozen, text drift allowed, in-flight defers', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.upsertExecTask({ id: 'a-task', projectId: 'proj', state: 'DONE', stage: 'reviewer', history: [{ at: 'x' }] });
  store.upsertExecTask({ id: 'b-task', projectId: 'proj', state: 'WORKING', stage: 'developer', history: [] });
  // structural change to DONE task -> blocked
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertTask', task: { ...TASK_A, executionMode: 'staged' } }]);
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => e.code === 'REVISE_COMPLETED_TASK');
  store.discardDraft();
  // removing in-flight task -> defer
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'removeTask', taskId: 'b-task' }]);
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => e.code === 'UNIFIED_TASK_DELIVERY_IN_FLIGHT');
  store.discardDraft();
  // text-only drift on DONE task -> allowed
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertTask', task: { ...TASK_A, title: 'Alpha task (renamed)' } }]);
  const res = store.promoteDraft({ approvedBy: 'pm' });
  assert.equal(store.getProdVersion(), res.version);
  const eff = store.getEffectiveTask('a-task');
  assert.equal(eff.state, 'DONE');
  assert.equal(eff.title, 'Alpha task (renamed)');
  assert.equal(eff.history.length, 1);
});

test('embedded process tasks pass through the effective view', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.upsertExecTask({ id: 'planner:batch-1', projectId: 'proj', taskKind: 'PLANNING', state: 'WORKING', stage: 'tech_lead', flowId: 'planner:batch-1' }, { embedded: true });
  const eff = store.getEffectiveTask('planner:batch-1');
  assert.equal(eff.taskKind, 'PLANNING');
  assert.equal(eff.state, 'WORKING');
});

test('legacy zone roundtrip and live issues', (t) => {
  const store = makeStore(t);
  store.putLegacyEntries([
    { kind: 'done_card', oldId: 'a-task', summary: 'Alpha done', payload: { verdict: 'PASS' } },
    { kind: 'skipped_index', oldId: 'old-x', summary: 'dropped', payload: { reason: 'superseded' } },
  ]);
  assert.equal(store.listLegacy().length, 2);
  assert.equal(store.listLegacy('done_card').length, 1);
  const card = store.getLegacy('done_card', 'a-task');
  assert.equal(card.payload.verdict, 'PASS');
  assert.ok(card.sourceHash.length === 64);
  const issue = store.createIssue({ id: 'issue-1', title: 'Bug', severity: 'high' });
  assert.equal(issue.state, 'OPEN');
  store.updateIssue('issue-1', { state: 'ASSIGNED' });
  assert.equal(store.listIssues({ states: ['ASSIGNED'] }).length, 1);
  assert.equal(store.listIssues({ states: ['OPEN'] }).length, 0);
});
