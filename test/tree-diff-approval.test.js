import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { promoteVersionedDraft } from '../src/v2/versioned-promotion.js';

// Owner design (2026-11-22): tree changes are patches, reviewers
// approve the diff, and promotion lands exactly the approved diff.
// These tests pin the three mechanisms: patch ops cannot lose
// unlisted fields, whole-object replacement of an existing node is
// not offered, and promotion refuses an empty diff or a diff whose
// hash differs from the approved one.

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-tda-'));
  const store = new VersionedStore(join(dir, 'state.db'));
  store.initProject('proj');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const CONTRACT = {
  id: 'feature.alpha', nodeType: 'feature',
  exportedInterfaces: [{ id: 'alpha_api' }],
  behavior: ['Alpha must charge before it can fire.'],
};
const TASK_A = {
  id: 'a-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Alpha task',
  parentId: null, dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct',
  intent: 'Build alpha.', acceptanceCriteria: ['Alpha fires', 'Alpha recharges'], testStrategy: 'unit',
};

function seedV1(store) {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'createContract', contract: CONTRACT },
    { op: 'createTask', task: TASK_A },
  ]);
  return store.promoteDraft({ approvedBy: 'pm' });
}

test('patchTask changes only the named fields; unlisted fields are preserved', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { title: 'Alpha task v2' } }]);
  store.promoteDraft({ approvedBy: 'pm' });
  const eff = store.getEffectiveTask('a-task');
  assert.equal(eff.title, 'Alpha task v2');
  assert.deepEqual(eff.acceptanceCriteria, ['Alpha fires', 'Alpha recharges']);
  assert.equal(eff.testStrategy, 'unit');
  assert.equal(eff.intent, 'Build alpha.');
});

test('whole-object replacement of an existing node is rejected; patch is the only way to change one', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  assert.throws(
    () => store.applyTreeOps([{ op: 'upsertTask', task: { ...TASK_A, title: 'sneaky' } }]),
    (e) => e.code === 'BAD_OP' && /patchTask/.test(e.message),
  );
  assert.throws(
    () => store.applyTreeOps([{ op: 'createTask', task: TASK_A }]),
    (e) => e.code === 'BAD_OP' && /patchTask/.test(e.message),
  );
  assert.throws(
    () => store.applyTreeOps([{ op: 'upsertContract', contract: CONTRACT }]),
    (e) => e.code === 'BAD_OP' && /patchContract/.test(e.message),
  );
  // The draft is untouched by the rejected ops.
  assert.equal(store.diffDraft().tasks.changed.length, 0);
});

test('patchTask validates its field schema and the target must exist', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  assert.throws(
    () => store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { bogusField: 1 } }]),
    (e) => e.code === 'BAD_OP' && /bogusField/.test(e.message),
  );
  assert.throws(
    () => store.applyTreeOps([{ op: 'patchTask', taskId: 'nope', set: { title: 'x' } }]),
    (e) => e.code === 'BAD_OP' && /createTask/.test(e.message),
  );
});

test('patchContract merges into the existing contract', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'patchContract', contractId: 'feature.alpha', set: { behavior: ['Alpha charges, then fires twice.'] } }]);
  const diff = store.diffDraft();
  assert.deepEqual(diff.contracts.changed, ['feature.alpha']);
  assert.deepEqual(diff.detail.contracts['feature.alpha'].behavior.to, ['Alpha charges, then fires twice.']);
  store.promoteDraft({ approvedBy: 'pm' });
  const contract = store.listSpecContracts(store.getProdVersion()).find(c => c.id === 'feature.alpha');
  assert.deepEqual(contract.behavior, ['Alpha charges, then fires twice.']);
  assert.deepEqual(contract.exportedInterfaces, [{ id: 'alpha_api' }]);
});

test('promotion refuses an empty diff (a draft identical to prod lands nothing)', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  assert.throws(
    () => promoteVersionedDraft({ versionedStore: store, approvedBy: 'pm' }),
    (e) => e.code === 'EMPTY_DIFF',
  );
  assert.equal(store.getProdVersion(), 1);
});

test('promotion lands exactly the approved diff: hash binding', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { title: 'Alpha task v2' } }]);
  const approvedHash = store.diffDraft().diffHash;
  // The draft changes after approval: the approved hash no longer
  // matches, and promotion refuses to land the unapproved diff.
  store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { intent: 'Changed after approval.' } }]);
  const currentHash = store.diffDraft().diffHash;
  assert.notEqual(currentHash, approvedHash);
  assert.throws(
    () => promoteVersionedDraft({ versionedStore: store, approvedBy: 'pm', expectedDiffHash: approvedHash }),
    (e) => e.code === 'DIFF_CHANGED_SINCE_APPROVAL',
  );
  assert.equal(store.getProdVersion(), 1);
  // Approving the diff as it now stands lands it.
  const res = promoteVersionedDraft({ versionedStore: store, approvedBy: 'pm', expectedDiffHash: currentHash });
  assert.equal(res.diffHash, currentHash);
  assert.equal(store.getProdVersion(), 2);
  assert.equal(store.getEffectiveTask('a-task').intent, 'Changed after approval.');
});

test('diffHash is stable for an unchanged draft and changes with the draft', (t) => {
  const store = makeStore(t);
  seedV1(store);
  store.createDraft({ createdBy: 'tl' });
  const h0 = store.diffDraft().diffHash;
  assert.equal(store.diffDraft().diffHash, h0);
  store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { title: 'Alpha task v2' } }]);
  const h1 = store.diffDraft().diffHash;
  assert.notEqual(h1, h0);
  // Reverting the change restores the original hash: the hash names
  // the delta, not the draft's history.
  store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { title: 'Alpha task' } }]);
  assert.equal(store.diffDraft().diffHash, h0);
});
