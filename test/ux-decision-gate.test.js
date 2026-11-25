import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { promoteVersionedDraft } from '../src/v2/versioned-promotion.js';

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-uxgate-'));
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
const TASK_PLAIN = { id: 'plain-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Plain task', parentId: null, dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };
const TASK_UX_FALSE = { id: 'logic-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Logic task', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct', ux: { required: false } };
const TASK_UX_TRUE = { id: 'visual-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Visual task', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct', ux: { required: true } };

function openDraftWith(store, tasks) {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'upsertContract', contract: FEATURE_CONTRACT },
    ...tasks.map(task => ({ op: 'upsertTask', task })),
  ]);
  return store.getOpenDraft().version;
}

const uxErrors = (errors) => errors.filter(e => e.includes('ux.required is not declared'));

test('validateVersion does not require ux declarations unless the gate is on', (t) => {
  const store = makeStore(t);
  const version = openDraftWith(store, [TASK_PLAIN]);
  assert.deepEqual(uxErrors(store.validateVersion(version)), []);
  assert.deepEqual(uxErrors(store.validateVersion(version, {})), []);
  assert.deepEqual(uxErrors(store.validateVersion(version, { requireUxDecision: false })), []);
});

test('the gate names every live task lacking an explicit ux declaration', (t) => {
  const store = makeStore(t);
  const version = openDraftWith(store, [TASK_PLAIN, TASK_UX_FALSE, TASK_UX_TRUE]);
  const errors = uxErrors(store.validateVersion(version, { requireUxDecision: true }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /task plain-task: ux\.required is not declared/);
});

test('a non-boolean ux.required does not count as a declaration', (t) => {
  const store = makeStore(t);
  const vague = { ...TASK_PLAIN, id: 'vague-task', ux: {} };
  const version = openDraftWith(store, [vague]);
  const errors = uxErrors(store.validateVersion(version, { requireUxDecision: true }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /task vague-task: ux\.required is not declared/);
});

test('finished tasks are exempt from the gate; unfinished ones are not', (t) => {
  const store = makeStore(t);
  const v1 = openDraftWith(store, [TASK_PLAIN, TASK_UX_FALSE]);
  store.promoteDraft({ approvedBy: 'pm' });
  store.upsertExecTask({ id: 'plain-task', projectId: 'proj', state: 'DONE', history: [] });
  store.createDraft({ createdBy: 'tl' });
  const draft = store.getOpenDraft();
  assert.equal(draft.version, v1 + 1);
  // The DONE plain-task needs no declaration; logic-task declared false.
  assert.deepEqual(uxErrors(store.validateVersion(draft.version, { requireUxDecision: true })), []);
  // A new undeclared task in the same draft is still gated.
  store.applyTreeOps([{ op: 'upsertTask', task: { ...TASK_PLAIN, id: 'fresh-task' } }]);
  const errors = uxErrors(store.validateVersion(draft.version, { requireUxDecision: true }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /task fresh-task: ux\.required is not declared/);
});

test('promoteVersionedDraft enforces the gate only when uxReviewEnabled', (t) => {
  const store = makeStore(t);
  openDraftWith(store, [TASK_PLAIN]);
  assert.throws(
    () => promoteVersionedDraft({ versionedStore: store, uxReviewEnabled: true }),
    (e) => e.code === 'TREE_VALIDATION_FAILED' && /plain-task/.test(e.message),
  );
  // The same draft promotes cleanly with the gate off.
  const landed = promoteVersionedDraft({ versionedStore: store, uxReviewEnabled: false });
  assert.equal(landed.version, 1);
  assert.equal(store.getProdVersion(), 1);
});
