import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionedStore } from '../src/v2/versioned-store.js';

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-retire-'));
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
const mkTask = (id, extra = {}) => ({
  id, taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: `${id} title`,
  parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct', ...extra,
});

function seed(store, execStates) {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'upsertContract', contract: FEATURE_CONTRACT },
    ...Object.keys(execStates).map(id => ({ op: 'upsertTask', task: mkTask(id) })),
  ]);
  store.promoteDraft({ approvedBy: 'pm' });
  for (const [id, data] of Object.entries(execStates)) {
    store.upsertExecTask({ id, projectId: 'proj', stage: 'developer', history: [], ...data });
  }
}

function retire(store, id, reason = 'superseded by owner decision 2026-11-27') {
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'patchTask', taskId: id, set: { retirement: { reason } } }]);
}

test('retiring a DONE task promotes, obsoletes the exec record, and keeps history', (t) => {
  const store = makeStore(t);
  seed(store, { 'a-task': { state: 'DONE', history: [{ type: 'ROLE_RESULT', summary: 'shipped' }] } });
  retire(store, 'a-task');
  const out = store.promoteDraft({ approvedBy: 'pm' });
  assert.deepEqual(out.retired, ['a-task']);
  assert.equal(store.listSpecTasks(store.getProdVersion()).some(x => x.id === 'a-task'), false);
  const ex = store.getExecTask('a-task');
  assert.equal(ex.data.state, 'OBSOLETE');
  assert.equal(ex.data.history[0].type, 'ROLE_RESULT');
  const last = ex.data.history[ex.data.history.length - 1];
  assert.equal(last.type, 'TASK_RETIRED');
  assert.match(last.reason, /superseded/);
  const eff = store.getEffectiveTask('a-task');
  assert.equal(eff.state, 'OBSOLETE');
});

test('retiring a started READY task (executed stages in history) promotes', (t) => {
  const store = makeStore(t);
  seed(store, { 'a-task': { state: 'READY', history: [{ type: 'ROLE_RESULT', summary: 'developer PASS' }] } });
  retire(store, 'a-task');
  const out = store.promoteDraft({ approvedBy: 'pm' });
  assert.deepEqual(out.retired, ['a-task']);
  assert.equal(store.getExecTask('a-task').data.state, 'OBSOLETE');
});

test('retiring an in-flight task is refused at promotion', (t) => {
  const store = makeStore(t);
  seed(store, { 'a-task': { state: 'WORKING' } });
  retire(store, 'a-task');
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => {
    assert.equal(e.code, 'RETIRE_TASK_IN_FLIGHT');
    return true;
  });
  assert.equal(store.getExecTask('a-task').data.state, 'WORKING');
});

test('retiring a gated task is refused until the gate is decided', (t) => {
  const store = makeStore(t);
  seed(store, { 'a-task': { state: 'NEEDS_HUMAN' } });
  retire(store, 'a-task');
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => {
    assert.equal(e.code, 'RETIRE_TASK_GATED');
    return true;
  });
});

test('retirement without a reason fails validation', (t) => {
  const store = makeStore(t);
  seed(store, { 'a-task': { state: 'DONE' } });
  store.createDraft({ createdBy: 'tl' });
  assert.throws(
    () => store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { retirement: { reason: '  ' } } }]),
    (e) => e.code === 'TREE_VALIDATION_FAILED' && e.details.some(d => d.includes('a-task') && d.includes('retirement')),
  );
});

test('retirement with a live dependent fails validation; co-retiring clears it', (t) => {
  const store = makeStore(t);
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'upsertContract', contract: FEATURE_CONTRACT },
    { op: 'upsertTask', task: mkTask('a-task') },
    { op: 'upsertTask', task: mkTask('b-task', { dependsOn: ['a-task'] }) },
  ]);
  store.promoteDraft({ approvedBy: 'pm' });
  store.upsertExecTask({ id: 'a-task', projectId: 'proj', state: 'DONE', stage: 'reviewer', history: [] });
  store.createDraft({ createdBy: 'tl' });
  // applyTreeOps validates the post-op draft, so a retirement that strands
  // a dependent is rejected at apply time with the fix named in details.
  assert.throws(
    () => store.applyTreeOps([{ op: 'patchTask', taskId: 'a-task', set: { retirement: { reason: 'scope dropped' } } }]),
    (e) => e.code === 'TREE_VALIDATION_FAILED' && e.details.some(d => d.includes('b-task') && d.includes('a-task')),
  );
  // Retire + rewire atomically in one batch validates clean.
  store.applyTreeOps([
    { op: 'patchTask', taskId: 'a-task', set: { retirement: { reason: 'scope dropped' } } },
    { op: 'patchTask', taskId: 'b-task', set: { dependsOn: [] } },
  ]);
  assert.deepEqual(store.validateVersion(store.getOpenDraft().version), []);
  const out = store.promoteDraft({ approvedBy: 'pm' });
  assert.deepEqual(out.retired, ['a-task']);
});

test('retirement cannot smuggle a gate-signature change on the retired task', (t) => {
  const store = makeStore(t);
  seed(store, { 'a-task': { state: 'DONE' }, 'b-task': { state: 'READY' } });
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([
    { op: 'patchTask', taskId: 'a-task', set: { retirement: { reason: 'scope dropped' }, dependsOn: ['b-task'] } },
  ]);
  assert.throws(() => store.promoteDraft({ approvedBy: 'pm' }), (e) => {
    assert.equal(e.code, 'REVISE_COMPLETED_TASK');
    return true;
  });
  assert.equal(store.getExecTask('a-task').data.state, 'DONE');
});
