import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { requirementsStatus } from '../src/v2/project-docs.js';
import { restoreRequirementsCheckpoint } from '../src/v2/debug-requirements-checkpoint.js';

const DOC = '# Requirements\n\nSettled product description.\n';
const SHA = createHash('sha256').update(DOC).digest('hex');

function makeProject({ desiredState = 'STOPPED' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ariad-dbgckpt-'));
  const projectsRoot = join(root, 'projects');
  const workspace = join(root, 'ws');
  mkdirSync(join(workspace, '.ariad', 'docs'), { recursive: true });
  mkdirSync(join(projectsRoot, 'demo'), { recursive: true });
  writeFileSync(join(projectsRoot, 'demo', 'project-ref.json'), `${JSON.stringify({ id: 'demo', workspace }, null, 2)}\n`);
  writeFileSync(join(workspace, '.ariad', 'project.json'), `${JSON.stringify({ id: 'demo', desiredState }, null, 2)}\n`);
  writeFileSync(join(workspace, '.ariad', 'docs', 'REQUIREMENTS.md'), DOC);
  const store = new SQLiteV2Store(join(workspace, '.ariad', 'state.db'));
  store.createProject({ id: 'demo', workspace, desiredState, executionState: 'NEEDS_HUMAN', versionedTree: true, mode: 'TAKEOVER' });
  return { root, projectsRoot, workspace, store };
}

function addBatch(store, { id, batchId, purpose, stage, state }) {
  store.enqueuePlanningRequest({ id, projectId: 'demo', request: { purpose, instruction: 'x' }, context: { bootstrap: true, iteration: true } });
  store.createPlanningBatch({
    projectId: 'demo', batchId, requestIds: [id],
    tasks: [{ id: `planner:${batchId}:t`, stage, state, input: { planningBatchId: batchId, purpose } }],
  });
}

function archiveApproval(workspace, sha = SHA) {
  const dir = join(workspace, 'backups', 'pre-iterate-2026-01-01-00-00-00');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'requirements-approvals.json'), `${JSON.stringify({ requirements: { path: '.ariad/docs/REQUIREMENTS.md', sha256: sha, approvedBy: 'human-cli', approvedAt: '2026-10-31T00:00:00.000Z', version: null } }, null, 2)}\n`);
}

function counts(workspace) {
  const store = new SQLiteV2Store(join(workspace, '.ariad', 'state.db'));
  const result = { tasks: store.listTasks('demo').length, requests: store.listPlanningRequests('demo').length };
  store.close();
  return result;
}

test('restores the requirements-approved checkpoint from an archived approval', () => {
  const { projectsRoot, workspace, store } = makeProject();
  addBatch(store, { id: 'requirements:demo', batchId: 'batch-1-1', purpose: 'REQUIREMENTS_AUTHORING', stage: 'pm', state: 'NEEDS_HUMAN' });
  archiveApproval(workspace);
  store.close();
  const manager = new AriadProjectManager({ projectsRoot });
  const report = restoreRequirementsCheckpoint({ manager, name: 'demo', expectedSha256: SHA, now: new Date('2026-11-01T00:00:00.000Z') });
  assert.deepEqual(report.removedRequests, ['requirements:demo']);
  assert.deepEqual(report.removedTasks, ['planner:batch-1-1:t']);
  assert.deepEqual(counts(workspace), { tasks: 0, requests: 0 });
  const status = requirementsStatus(workspace);
  assert.equal(status.approved, true);
  // The original human approval is restored verbatim, not re-issued.
  assert.equal(status.approval.approvedBy, 'human-cli');
  assert.equal(status.approval.approvedAt, '2026-10-31T00:00:00.000Z');
  assert.equal(status.approval.restoredBy, 'debug-cli');
  assert.match(readFileSync(join(workspace, '.ariad', 'debug-ops.jsonl'), 'utf8'), /debug-restore-requirements/);
});

test('refuses when no prior human approval exists for the current hash', () => {
  const { projectsRoot, workspace, store } = makeProject();
  addBatch(store, { id: 'requirements:demo', batchId: 'batch-1-1', purpose: 'REQUIREMENTS_AUTHORING', stage: 'pm', state: 'NEEDS_HUMAN' });
  archiveApproval(workspace, 'deadbeef'.repeat(8));
  store.close();
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => restoreRequirementsCheckpoint({ manager, name: 'demo' }), /DEBUG_CHECKPOINT_NO_PRIOR_APPROVAL/);
  assert.deepEqual(counts(workspace), { tasks: 1, requests: 1 });
  assert.equal(requirementsStatus(workspace).approved, false);
});

test('refuses while planning beyond requirements exists, unless discardPlanning is set', () => {
  const { projectsRoot, workspace, store } = makeProject();
  addBatch(store, { id: 'requirements:demo', batchId: 'batch-1-1', purpose: 'REQUIREMENTS_AUTHORING', stage: 'pm', state: 'DONE' });
  addBatch(store, { id: 'demo:replan:1', batchId: 'batch-2-1', purpose: 'INITIAL_PLAN', stage: 'tech_lead', state: 'READY' });
  archiveApproval(workspace);
  store.close();
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => restoreRequirementsCheckpoint({ manager, name: 'demo' }), /DEBUG_CHECKPOINT_PLANNING_EXISTS/);
  const report = restoreRequirementsCheckpoint({ manager, name: 'demo', discardPlanning: true });
  assert.equal(report.removedRequests.length, 2);
  assert.deepEqual(counts(workspace), { tasks: 0, requests: 0 });
});

test('refuses when a task is in flight or the project is not stopped', () => {
  const a = makeProject();
  addBatch(a.store, { id: 'requirements:demo', batchId: 'batch-1-1', purpose: 'REQUIREMENTS_AUTHORING', stage: 'pm', state: 'WORKING' });
  archiveApproval(a.workspace);
  a.store.close();
  assert.throws(() => restoreRequirementsCheckpoint({ manager: new AriadProjectManager({ projectsRoot: a.projectsRoot }), name: 'demo' }), /DEBUG_CHECKPOINT_IN_FLIGHT/);

  const b = makeProject({ desiredState: 'RUNNING' });
  addBatch(b.store, { id: 'requirements:demo', batchId: 'batch-1-1', purpose: 'REQUIREMENTS_AUTHORING', stage: 'pm', state: 'NEEDS_HUMAN' });
  archiveApproval(b.workspace);
  b.store.close();
  assert.throws(() => restoreRequirementsCheckpoint({ manager: new AriadProjectManager({ projectsRoot: b.projectsRoot }), name: 'demo' }), /DEBUG_CHECKPOINT_NOT_STOPPED/);
});

test('discards an open TL spec draft only with discardPlanning', () => {
  const { projectsRoot, workspace, store } = makeProject();
  addBatch(store, { id: 'requirements:demo', batchId: 'batch-1-1', purpose: 'REQUIREMENTS_AUTHORING', stage: 'pm', state: 'DONE' });
  addBatch(store, { id: 'demo:replan:1', batchId: 'batch-2-1', purpose: 'INITIAL_PLAN', stage: 'tech_lead', state: 'DONE' });
  archiveApproval(workspace);
  store.close();
  const versioned = new VersionedStore(join(workspace, '.ariad', 'state.db'));
  versioned.initProject('demo');
  versioned.createDraft({ createdBy: 'tech_lead' });
  versioned.close();
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => restoreRequirementsCheckpoint({ manager, name: 'demo' }), /DEBUG_CHECKPOINT_SPEC_DRAFT_EXISTS/);
  const report = restoreRequirementsCheckpoint({ manager, name: 'demo', discardPlanning: true });
  assert.equal(report.discardedDraftVersion, 1);
  const check = new VersionedStore(join(workspace, '.ariad', 'state.db'));
  assert.equal(check.getOpenDraft(), null);
  assert.equal(check.listVersions()[0].state, 'discarded');
  check.close();
  assert.deepEqual(counts(workspace), { tasks: 0, requests: 0 });
});

function makeProjectWithoutStore({ desiredState = 'STOPPED' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ariad-dbgfresh-'));
  const projectsRoot = join(root, 'projects');
  const workspace = join(root, 'ws');
  mkdirSync(join(workspace, '.ariad', 'docs'), { recursive: true });
  mkdirSync(join(projectsRoot, 'demo'), { recursive: true });
  writeFileSync(join(projectsRoot, 'demo', 'project-ref.json'), `${JSON.stringify({ id: 'demo', workspace }, null, 2)}\n`);
  writeFileSync(join(workspace, '.ariad', 'project.json'), `${JSON.stringify({
    id: 'demo', desiredState, executionState: 'RUNNING', workspace,
    goal: 'Build the thing', spec: 'Build the thing, exactly', mode: 'TAKEOVER',
    roleModels: { pm: 'x/y' }, projectVersion: 3, activeVersion: 4,
  }, null, 2)}\n`);
  writeFileSync(join(workspace, '.ariad', 'docs', 'REQUIREMENTS.md'), DOC);
  return { root, projectsRoot, workspace };
}

test('without --fresh-store a missing store still fails DEBUG_CHECKPOINT_DB_MISSING', () => {
  const { projectsRoot, workspace } = makeProjectWithoutStore();
  archiveApproval(workspace);
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => restoreRequirementsCheckpoint({ manager, name: 'demo', expectedSha256: SHA }), /DEBUG_CHECKPOINT_DB_MISSING/);
  assert.equal(existsSync(join(workspace, '.ariad', 'state.db')), false);
});

test('--fresh-store without a prior approval fails and builds no store', () => {
  const { projectsRoot, workspace } = makeProjectWithoutStore();
  archiveApproval(workspace, 'deadbeef'.repeat(8));
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(
    () => restoreRequirementsCheckpoint({ manager, name: 'demo', expectedSha256: SHA, freshStore: true }),
    /DEBUG_CHECKPOINT_NO_PRIOR_APPROVAL/,
  );
  assert.equal(existsSync(join(workspace, '.ariad', 'state.db')), false);
  const ref = JSON.parse(readFileSync(join(projectsRoot, 'demo', 'project-ref.json'), 'utf8'));
  assert.equal(ref.dbFile, undefined);
});

test('--fresh-store builds the canonical store and restores the checkpoint', () => {
  const { projectsRoot, workspace } = makeProjectWithoutStore();
  archiveApproval(workspace);
  const manager = new AriadProjectManager({ projectsRoot });
  const report = restoreRequirementsCheckpoint({
    manager, name: 'demo', expectedSha256: SHA, freshStore: true,
    now: new Date('2026-11-03T00:00:00.000Z'),
  });
  assert.equal(report.freshStore, true);
  assert.equal(report.dbFile, 'state.db');
  const dbPath = join(workspace, '.ariad', 'state.db');
  assert.ok(existsSync(dbPath));
  const ref = JSON.parse(readFileSync(join(projectsRoot, 'demo', 'project-ref.json'), 'utf8'));
  assert.equal(ref.dbFile, 'state.db');
  assert.equal(manager.resolveProjectPaths('demo').db, dbPath);
  const store = new SQLiteV2Store(dbPath);
  const project = store.getProject('demo');
  assert.equal(project.versionedTree, true);
  assert.equal(project.unifiedTaskCompilerVersion, 1);
  assert.equal(project.deliveryEnabled, false);
  assert.equal(project.desiredState, 'STOPPED');
  assert.equal(project.executionState, 'IDLE');
  assert.equal(project.goal, 'Build the thing');
  assert.equal(project.spec, 'Build the thing, exactly');
  assert.equal(project.mode, 'TAKEOVER');
  assert.equal(project.workspace, workspace);
  assert.deepEqual(project.roleModels, { pm: 'x/y' });
  store.close();
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  raw.close();
  for (const table of ['spec_versions', 'spec_tasks', 'spec_contracts']) assert.ok(tables.includes(table), table);
  const versioned = new VersionedStore(dbPath);
  assert.equal(versioned.projectId, 'demo');
  assert.deepEqual(versioned.listVersions(), []);
  versioned.close();
  const status = requirementsStatus(workspace);
  assert.equal(status.approved, true);
  assert.equal(status.approval.approvedBy, 'human-cli');
  assert.equal(status.approval.restoredBy, 'debug-cli');
  const audit = readFileSync(join(workspace, '.ariad', 'debug-ops.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.at(-1).op, 'debug-restore-requirements');
  assert.equal(audit.at(-1).project, 'demo');
  assert.deepEqual(counts(workspace), { tasks: 0, requests: 0 });
});

test('--fresh-store with an existing store takes the original path and does not rebuild', () => {
  const { projectsRoot, workspace, store } = makeProject();
  addBatch(store, { id: 'requirements:demo', batchId: 'batch-1-1', purpose: 'REQUIREMENTS_AUTHORING', stage: 'pm', state: 'NEEDS_HUMAN' });
  archiveApproval(workspace);
  store.close();
  const manager = new AriadProjectManager({ projectsRoot });
  const report = restoreRequirementsCheckpoint({ manager, name: 'demo', expectedSha256: SHA, freshStore: true });
  assert.equal(report.freshStore, undefined);
  assert.equal(report.dbFile, 'state.db');
  assert.deepEqual(report.removedRequests, ['requirements:demo']);
  assert.deepEqual(counts(workspace), { tasks: 0, requests: 0 });
  const ref = JSON.parse(readFileSync(join(projectsRoot, 'demo', 'project-ref.json'), 'utf8'));
  assert.equal(ref.dbFile, undefined);
});
