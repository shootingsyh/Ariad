import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { createDefaultV2Roles, pmRevisionRoundsSinceAcceptance } from '../src/v2/default-roles.js';
import { plannerPrompt, criticPrompt } from '../src/v2/role-prompts.js';

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
  assert.match(prompt, /PM PLAN REVISION \(CONTINUE THE REJECTED DRAFT AS A NEW VERSION\)/);
  assert.match(prompt, /openRevisionDraft/);
  assert.match(prompt, /NEVER call discardDraft/);
  assert.match(prompt, /character-for-character/);
  assert.match(prompt, /FAIL trace: clause missing/);
});

// Second half of the lineage fix (owner directive 2026-11-02: "an
// update gets a new minor version"): a revision round must not edit
// the rejected version in place. createRevisionDraft mints the next
// version seeded from the rejected draft and supersedes the old one,
// so every round has its own version identity and PM reports name a
// draft whose content is stable under that name.

test('createRevisionDraft mints the next version from the rejected draft and supersedes it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-revmint-'));
  const dbPath = join(dir, 'state2.db');
  const store = new VersionedStore(dbPath);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initProject('P');
  store.createDraft({ createdBy: 'tl' });
  store.applyTreeOps([{ op: 'upsertContract', contract: CONTRACT }, { op: 'upsertTask', task: TASK_A }]);
  store.promoteDraft({ approvedBy: 'pm' });
  const rejected = store.createDraft({ createdBy: 'tl' });
  seedRevisionBase(dbPath, { version: rejected.version });
  const minted = store.createRevisionDraft({ createdBy: 'tl' });
  assert.equal(minted.version, rejected.version + 1);
  assert.equal(minted.supersededVersion, rejected.version);
  assert.equal(minted.base_version, rejected.base_version);
  assert.equal(store.getOpenDraft().version, minted.version);
  const states = Object.fromEntries(store.listVersions().map(v => [v.version, v.state]));
  assert.equal(states[rejected.version], 'superseded');
  assert.equal(states[minted.version], 'draft');
  // Superseded content is retained; the new draft inherits it whole.
  assert.deepEqual(store.listSpecTasks(rejected.version).map(x => x.id), ['a-task']);
  assert.deepEqual(store.listSpecTasks(minted.version).map(x => x.id), ['a-task']);
});

test('createRevisionDraft refuses when the open draft is not a named revision base', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-revmint-no-'));
  const dbPath = join(dir, 'state2.db');
  const store = new VersionedStore(dbPath);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initProject('P');
  assert.throws(() => store.createRevisionDraft({ createdBy: 'tl' }), (e) => e.code === 'NO_OPEN_DRAFT');
  store.createDraft({ createdBy: 'tl' });
  assert.throws(() => store.createRevisionDraft({ createdBy: 'tl' }), (e) => e.code === 'NOT_A_REVISION_BASE');
});

test('discardDraft stays refused for the minted continuation while the revision is live', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-revguard2-'));
  const dbPath = join(dir, 'state2.db');
  const store = new VersionedStore(dbPath);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initProject('P');
  const rejected = store.createDraft({ createdBy: 'tl' });
  seedRevisionBase(dbPath, { version: rejected.version, state: 'CLAIMED' });
  const minted = store.createRevisionDraft({ createdBy: 'tl' });
  assert.equal(store.getOpenDraft().version, minted.version);
  assert.throws(() => store.discardDraft(), (e) => e.code === 'DRAFT_IS_REVISION_BASE');
  execSql(dbPath, "UPDATE v2_planning_requests SET state = 'PLANNED'");
  store.discardDraft();
  assert.equal(store.getOpenDraft(), null);
});

test('the revision round counter resets at an owner decision on a PM task', () => {
  const req = (createdAt) => ({ createdAt, request: { purpose: 'PM_PLAN_REVISION' } });
  const store = {
    listPlanningRequests: () => [req('2026-11-02T00:00:00.000Z'), req('2026-11-02T06:00:00.000Z'), req('2026-11-03T00:00:00.000Z')],
    listTasks: () => [
      { stage: 'pm', history: [{ type: 'HUMAN_DECISION', at: '2026-11-02T03:00:00.000Z' }] },
      { stage: 'pm', history: [{ type: 'ROLE_RESULT', role: 'pm', outcome: 'PLAN_ACCEPTED', completedAt: '2026-11-01T00:00:00.000Z' }] },
      { stage: 'developer', history: [{ type: 'HUMAN_DECISION', at: '2026-11-02T09:00:00.000Z' }] },
    ],
  };
  // Only requests after the owner decision count; the developer-stage
  // decision must not reset the PM counter.
  assert.equal(pmRevisionRoundsSinceAcceptance(store, 'P'), 2);
});

// Third half of the lineage fix (SRPG batches 76-80, 2026-11-03): the
// decompose pass kept landing the verbatim clauses, then the critic /
// repair passes rewrote them away - critic-1 in batch-80 caught
// malformed shells contradicting the decompose claims, and repair-1
// "fixed" the shells by rewording the ACs into English-only text,
// while the critic never saw the PM fidelity trace at all (its batch
// payload stripped revision requests to purpose/title). So the
// verbatim clauses now survive the whole chain: decompose verifies
// after writing, and the critic and repair prompts carry the PM
// revision review with a protected-strings rule.

test('the decompose prompt orders verify-after-write for quoted clauses', () => {
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
  assert.match(prompt, /re-read the tasks you touched/);
  assert.match(prompt, /a summary claiming a fix is not evidence/);
});

test('the repair prompt protects quoted clauses in a PM revision batch', () => {
  const store = { listTasks: () => [] };
  const prompt = plannerPrompt({
    store,
    project: { id: 'P', mode: 'NEW' },
    task: {
      id: 'planner:batch-9-9:repair-1', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead',
      input: {
        purpose: 'PLANNER_REPAIR',
        requests: [{
          id: 'P:replan:x:1',
          request: { purpose: 'PM_PLAN_REVISION', reason: 'FAIL trace: clause missing', guidance: 'paste it verbatim', rejectedDraftVersion: 70 },
          context: { sourceKind: 'pm-plan-revision' },
        }],
      },
      dependsOn: [],
      history: [],
    },
  });
  assert.match(prompt, /VERBATIM-PROTECTED STRINGS/);
  assert.match(prompt, /never let a critic finding rewrite them/);
  assert.match(prompt, /FAIL trace: clause missing/);
});

test('the critic prompt carries the PM revision review and the protected rule', () => {
  const store = {
    listPlanningRequests: () => [{
      batchId: 'batch-9-9',
      request: { purpose: 'PM_PLAN_REVISION', reason: 'FAIL trace: clause missing', guidance: 'paste it verbatim', rejectedDraftVersion: 70 },
    }],
    listTasks: () => [],
  };
  const prompt = criticPrompt({
    store,
    project: { id: 'P' },
    task: { id: 'planner:batch-9-9:critic-1', projectId: 'P', flowId: 'planner:batch-9-9', input: { purpose: 'PLANNER_CRITIC', planningBatchId: 'batch-9-9' }, dependsOn: [] },
  });
  assert.match(prompt, /VERBATIM FIDELITY/);
  assert.match(prompt, /FAIL trace: clause missing/);
  assert.match(prompt, /paste it verbatim/);
});
