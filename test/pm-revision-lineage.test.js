import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { plannerPrompt } from '../src/v2/role-prompts.js';

// Revision-lineage regression (2026-11-02, SRPG): PM plan revision
// rounds never converged - five consecutive PLAN_REVISION_REQUIRED
// verdicts, then a human park. Root cause: every round the Tech Lead
// discarded the rejected draft and opened a fresh one seeded from
// prod (drafts v64-v69 all show base = prod v63, state discarded), so
// fixes landed in a discarded draft evaporated and PM feedback had to
// be re-derived from prose each round; quoted verbatim clauses were
// paraphrased instead of pasted. The fix pins the lineage end to end:
// the revision request names the rejected draft and carries the full
// PM reason, the decompose prompt orders the TL to continue that
// draft in place, and the store refuses to discard a named revision
// base.

const CONTRACT = { id: 'feature.alpha', nodeType: 'feature', exportedInterfaces: [{ id: 'alpha_api' }], behavior: ['Alpha behaves.'] };
const TASK_A = { id: 'a-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Alpha task', executionMode: 'direct' };

function execSql(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try { db.prepare(sql).run(...params); } finally { db.close(); }
}

function seedRevisionBase(dbPath, { version, state = 'PENDING' }) {
  execSql(dbPath, 'CREATE TABLE IF NOT EXISTS v2_planning_requests (id TEXT, state TEXT, data_json TEXT)');
  execSql(dbPath, 'INSERT INTO v2_planning_requests (id, state, data_json) VALUES (?, ?, ?)',
    ['P:replan:test:1', state, JSON.stringify({ request: { purpose: 'PM_PLAN_REVISION', rejectedDraftVersion: version }, context: {} })]);
}

test('discardDraft refuses while the open draft is a live revision base', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-revbase-'));
  const dbPath = join(dir, 'state2.db');
  const store = new VersionedStore(dbPath);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initProject('P');
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertContract', contract: CONTRACT }, { op: 'upsertTask', task: TASK_A }]);
  store.promoteDraft({ approvedBy: 'pm' });
  const draft = store.createDraft({ createdBy: 'tl' });
  seedRevisionBase(dbPath, { version: draft.version });
  assert.equal(store.revisionBaseDraftVersion(), draft.version);
  assert.throws(() => store.discardDraft(), (e) => e.code === 'DRAFT_IS_REVISION_BASE');
  // The batch finished (request PLANNED): the base is released.
  execSql(dbPath, "UPDATE v2_planning_requests SET state = 'PLANNED'");
  assert.equal(store.revisionBaseDraftVersion(), null);
  store.discardDraft();
  assert.equal(store.getOpenDraft(), null);
});

test('an operator force-discard overrides the revision-base guard', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-revforce-'));
  const dbPath = join(dir, 'state2.db');
  const store = new VersionedStore(dbPath);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initProject('P');
  const draft = store.createDraft({ createdBy: 'tl' });
  seedRevisionBase(dbPath, { version: draft.version, state: 'CLAIMED' });
  assert.equal(store.revisionBaseDraftVersion(), draft.version);
  store.discardDraft({ force: true });
  assert.equal(store.getOpenDraft(), null);
});

test('a PM rejection carries the full reason and the rejected draft version', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-revcarry-'));
  const dbPath = join(dir, 'state2.db');
  const vs = new VersionedStore(dbPath);
  t.after(() => { try { vs.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  vs.initProject('P');
  const draft = vs.createDraft({ createdBy: 'tl' });
  vs.applyTreeOps([{ op: 'upsertContract', contract: CONTRACT }, { op: 'upsertTask', task: TASK_A }]);
  vs.close();
  const enqueued = [];
  const store = { filePath: dbPath, getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD' }) };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: req => enqueued.push(req) });
  const task = { id: 'planner:batch-3-3:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'PLANNER_PM_REVIEW' } };
  const out = roles.pm.transition({ task, result: { outcome: 'PLAN_REVISION_REQUIRED', result: { guidance: 'paste the clause verbatim', reason: 'FAIL trace: M-v25 AC5 missing verbatim prefix' } } });
  assert.equal(out.state, 'DONE');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].request.purpose, 'PM_PLAN_REVISION');
  assert.equal(enqueued[0].request.reason, 'FAIL trace: M-v25 AC5 missing verbatim prefix');
  assert.equal(enqueued[0].request.guidance, 'paste the clause verbatim');
  assert.equal(enqueued[0].request.rejectedDraftVersion, draft.version);
});

test('the decompose prompt orders continuation of the rejected draft for a PM revision', () => {
  const prompt = plannerPrompt({
    project: { id: 'P', mode: 'NEW' },
    task: {
      id: 'planner:batch-9-9:decompose', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead',
      input: {
        purpose: 'PLANNER_DECOMPOSE',
        requests: [{
          id: 'P:replan:x:1',
          request: { purpose: 'PM_PLAN_REVISION', reason: 'FAIL trace: clause missing', guidance: 'paste it verbatim', rejectedDraftVersion: 70 },
          context: { sourceKind: 'pm-plan-revision' },
        }],
      },
      history: [],
    },
  });
  assert.match(prompt, /PM PLAN REVISION \(CONTINUE THE REJECTED DRAFT\)/);
  assert.match(prompt, /NEVER call discardDraft/);
  assert.match(prompt, /character-for-character/);
  assert.match(prompt, /FAIL trace: clause missing/);
});
