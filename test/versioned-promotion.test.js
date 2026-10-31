import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { reconcileVersionedDraft } from '../src/v2/versioned-promotion.js';

const CONTRACT = {
  id: 'feature.alpha', nodeType: 'feature',
  exportedInterfaces: [{ id: 'alpha_api' }],
  behavior: ['Alpha must charge before it can fire.'],
};
const A = { id: 'a-task', taskKind: 'FEATURE_TASK', title: 'Alpha task', parentId: null, dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };
const B = { id: 'b-task', taskKind: 'FEATURE_TASK', title: 'Beta task', parentId: null, dependsOn: ['a-task'], interfaceIds: [], executionMode: 'direct' };
const C = { id: 'c-task', taskKind: 'FEATURE_TASK', title: 'Gamma task', parentId: null, dependsOn: ['b-task'], interfaceIds: [], executionMode: 'direct' };

function makeStores(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-vp-'));
  const file = join(dir, 'state2.db');
  const runtime = new SQLiteV2Store(file);
  runtime.createProject({ id: 'proj', name: 'P' });
  const vs = new VersionedStore(file);
  vs.initProject('proj');
  t.after(() => { vs.close(); runtime.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, vs };
}

test('promotion materializes draft into runtime delivery tasks and flips prod', (t) => {
  const { runtime, vs } = makeStores(t);
  vs.createDraft({ createdBy: 'tl' });
  vs.applyTreeOps([
    { op: 'upsertContract', contract: CONTRACT },
    { op: 'upsertTask', task: A },
    { op: 'upsertTask', task: B },
  ]);
  const res = reconcileVersionedDraft({ versionedStore: vs, store: runtime, projectId: 'proj', approvedBy: 'pm' });
  assert.deepEqual(res.created.sort(), ['a-task', 'b-task']);
  assert.equal(res.version, 1);
  assert.equal(vs.getProdVersion(), 1);
  const delivery = runtime.listTasks('proj', { scope: 'delivery' });
  assert.equal(delivery.length, 2);
  assert.ok(delivery.every(x => x.state === 'READY'));
  assert.equal(runtime.getTask('a-task').unifiedTaskSchemaVersion, 1);
});

test('DONE prose drift tolerated without rewrite; gate drift refused; drops obsolete READY tasks', (t) => {
  const { runtime, vs } = makeStores(t);
  vs.createDraft({ createdBy: 'tl' });
  vs.applyTreeOps([
    { op: 'upsertContract', contract: CONTRACT },
    { op: 'upsertTask', task: A },
    { op: 'upsertTask', task: B },
  ]);
  reconcileVersionedDraft({ versionedStore: vs, store: runtime, projectId: 'proj', approvedBy: 'pm' });
  const a = runtime.getTask('a-task');
  runtime.updateTask(a.id, a.version, { state: 'DONE', stage: 'reviewer' });
  assert.equal(runtime.getTask('a-task').state, 'DONE');

  // draft 2: rename DONE task (prose) + add C
  vs.createDraft({ createdBy: 'tl' });
  vs.applyTreeOps([
    { op: 'upsertTask', task: { ...A, title: 'Alpha task renamed' } },
    { op: 'upsertTask', task: C },
  ]);
  const res2 = reconcileVersionedDraft({ versionedStore: vs, store: runtime, projectId: 'proj', approvedBy: 'pm' });
  assert.deepEqual(res2.created, ['c-task']);
  assert.equal(runtime.getTask('a-task').title, 'Alpha task'); // DONE prose never rewritten
  assert.equal(vs.getProdVersion(), 2);

  // draft 3: gate drift on DONE task -> refused, prod stays at 2
  vs.createDraft({ createdBy: 'tl' });
  vs.applyTreeOps([{ op: 'upsertTask', task: { ...A, title: 'Alpha task renamed', executionMode: 'staged' } }]);
  assert.throws(
    () => reconcileVersionedDraft({ versionedStore: vs, store: runtime, projectId: 'proj', approvedBy: 'pm' }),
    (e) => Array.isArray(e.issues) && e.issues.some(i => i.reason === 'REVISE_COMPLETED_TASK'),
  );
  assert.equal(vs.getProdVersion(), 2);
  vs.discardDraft();

  // draft 4: drop READY tasks C and B -> both obsoleted in runtime
  vs.createDraft({ createdBy: 'tl' });
  vs.applyTreeOps([
    { op: 'removeTask', taskId: 'c-task' },
    { op: 'removeTask', taskId: 'b-task' },
  ]);
  const res4 = reconcileVersionedDraft({ versionedStore: vs, store: runtime, projectId: 'proj', approvedBy: 'pm' });
  assert.deepEqual(res4.obsoleted.sort(), ['b-task', 'c-task']);
  assert.equal(runtime.getTask('b-task').state, 'OBSOLETE');
  assert.equal(runtime.getTask('a-task').state, 'DONE');
});
