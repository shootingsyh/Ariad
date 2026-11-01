import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalsPath, readApprovals, requirementsPath, requirementsStatus } from './project-docs.js';
import { DELIVERY_KINDS } from './versioned-store.js';

// DEBUG tool (operator surface, not a product flow): restore the
// checkpoint "requirements human-approved, TL planning not started".
// begin-iteration deliberately archives the approval, and the PM ->
// INITIAL_PLAN transition has no pause point, so this intermediate
// state is otherwise unreachable after the fact. This command
// reconstructs it on a STOPPED project by (a) restoring an approval
// record that a human actually gave for the document's exact current
// hash (found in the live approvals file or a pre-iterate archive -
// it never creates a fresh approval), and (b) deleting the
// requirements-stage planning batch (and, only with discardPlanning,
// any other planning batch) from the store. It enqueues nothing:
// the project stays STOPPED, and a later `project start` takes the
// already-existing ensureRunning branch straight to INITIAL_PLAN.
// Every run is appended to .ariad/debug-ops.jsonl for audit.
function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  throw err;
}
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function findPriorRequirementsApproval(workspace, sha256) {
  const candidates = [{ file: approvalsPath(workspace), source: 'current approvals.json' }];
  const backups = join(workspace, 'backups');
  if (existsSync(backups)) {
    for (const entry of readdirSync(backups).sort().reverse()) {
      if (entry.startsWith('pre-iterate-')) {
        candidates.push({ file: join(backups, entry, 'requirements-approvals.json'), source: `backups/${entry}/requirements-approvals.json` });
      }
    }
  }
  for (const { file, source } of candidates) {
    if (!existsSync(file)) continue;
    const record = parse(readFileSync(file, 'utf8')).requirements;
    if (record && record.sha256 === sha256) return { record, source };
  }
  return null;
}

export function restoreRequirementsCheckpoint({ manager, name, expectedSha256 = null, discardPlanning = false, now = new Date() } = {}) {
  if (!manager) fail('DEBUG_CHECKPOINT_MANAGER_REQUIRED', 'an AriadProjectManager is required');
  const paths = manager.resolveProjectPaths(name);
  if (!existsSync(paths.db)) fail('DEBUG_CHECKPOINT_DB_MISSING', `no store at ${paths.db}`);
  const docPath = requirementsPath(paths.workspace);
  if (!existsSync(docPath)) fail('DEBUG_CHECKPOINT_DOC_MISSING', 'REQUIREMENTS.md does not exist');
  const sha256 = sha256File(docPath);
  if (expectedSha256 && expectedSha256 !== sha256) {
    fail('DEBUG_CHECKPOINT_SHA_MISMATCH', `REQUIREMENTS.md hash is ${sha256}, not the expected ${expectedSha256}; nothing changed`);
  }
  const prior = findPriorRequirementsApproval(paths.workspace, sha256);
  if (!prior) {
    fail('DEBUG_CHECKPOINT_NO_PRIOR_APPROVAL', `no human approval for hash ${sha256} exists in the live approvals file or any pre-iterate archive; this debug command restores a past approval, it cannot create one`);
  }

  const db = new DatabaseSync(paths.db);
  let removedTasks = [];
  let removedRequests = [];
  try {
    const rows = db.prepare('SELECT id, data_json FROM v2_projects').all();
    const row = rows.find(r => r.id === paths.id) ?? (rows.length === 1 ? rows[0] : null);
    if (!row) fail('DEBUG_CHECKPOINT_PROJECT_MISSING', `no project record for ${paths.id}`);
    const project = { ...parse(row.data_json), id: row.id };
    let desiredState;
    try { desiredState = manager.status(name)?.desiredState; } catch { desiredState = undefined; }
    desiredState ??= project.desiredState;
    if (desiredState !== 'STOPPED') fail('DEBUG_CHECKPOINT_NOT_STOPPED', `project desiredState is ${desiredState ?? 'unset'}; stop the project first`);

    const tasks = db.prepare('SELECT id, data_json FROM v2_tasks WHERE project_id = ?').all(row.id)
      .map(r => ({ ...parse(r.data_json), id: r.id }));
    const inFlight = tasks.filter(t => ['WORKING', 'RESULT_READY'].includes(t.state)).map(t => t.id);
    if (inFlight.length) fail('DEBUG_CHECKPOINT_IN_FLIGHT', `tasks still in flight: ${inFlight.join(', ')}`);
    const delivery = tasks.filter(t => DELIVERY_KINDS.includes(t.taskKind)).map(t => t.id);
    if (delivery.length) fail('DEBUG_CHECKPOINT_DELIVERY_EXISTS', `delivery tasks already exist (${delivery.length}); the checkpoint is pre-planning`);
    try {
      const prod = db.prepare("SELECT COUNT(*) AS n FROM spec_versions WHERE state = 'prod'").get();
      if (prod?.n > 0) fail('DEBUG_CHECKPOINT_PROD_EXISTS', 'a promoted spec version already exists; the checkpoint is pre-planning');
      const drafts = db.prepare("SELECT COUNT(*) AS n FROM spec_versions WHERE state = 'draft'").get();
      if (drafts?.n > 0) fail('DEBUG_CHECKPOINT_SPEC_DRAFT_EXISTS', 'a TL spec draft already exists; discarding planning would orphan it, refusing');
    } catch (err) { if (err.code?.startsWith('DEBUG_CHECKPOINT_')) throw err; /* no spec tables yet: fine */ }

    const requests = db.prepare('SELECT id, state, batch_id, data_json FROM v2_planning_requests WHERE project_id = ?').all(row.id)
      .map(r => ({ id: r.id, state: r.state, batchId: r.batch_id, purpose: parse(r.data_json).request?.purpose ?? null }));
    const requirementsReqs = requests.filter(r => r.purpose === 'REQUIREMENTS_AUTHORING');
    const otherReqs = requests.filter(r => r.purpose !== 'REQUIREMENTS_AUTHORING');
    if (otherReqs.length && !discardPlanning) {
      fail('DEBUG_CHECKPOINT_PLANNING_EXISTS', `non-requirements planning already exists (${otherReqs.map(r => `${r.id}:${r.purpose ?? '?'}`).join(', ')}); rerun with --discard-planning to drop it too`);
    }
    const dropReqs = discardPlanning ? requests : requirementsReqs;
    const batches = new Set(dropReqs.map(r => r.batchId).filter(Boolean));
    removedRequests = dropReqs.map(r => r.id);
    removedTasks = tasks.filter(t => batches.has(t.input?.planningBatchId) || batches.has(String(t.flowId ?? '').split(':').pop())).map(t => t.id);
    const remaining = tasks.filter(t => !removedTasks.includes(t.id));
    if (remaining.length) {
      if (!discardPlanning) fail('DEBUG_CHECKPOINT_TASKS_REMAIN', `tasks outside the requirements batch remain (${remaining.map(t => t.id).join(', ')}); rerun with --discard-planning to drop all planning tasks`);
      removedTasks = tasks.map(t => t.id);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const delTask = db.prepare('DELETE FROM v2_tasks WHERE id = ? AND project_id = ?');
      for (const id of removedTasks) delTask.run(id, row.id);
      const delReq = db.prepare('DELETE FROM v2_planning_requests WHERE id = ? AND project_id = ?');
      for (const id of removedRequests) delReq.run(id, row.id);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  } finally { db.close(); }

  const approvals = readApprovals(paths.workspace);
  approvals.requirements = { ...prior.record, restoredBy: 'debug-cli', restoredAt: now.toISOString(), restoreSource: prior.source };
  writeFileSync(approvalsPath(paths.workspace), `${JSON.stringify(approvals, null, 2)}\n`);
  if (!requirementsStatus(paths.workspace).approved) fail('DEBUG_CHECKPOINT_VERIFY_FAILED', 'restored approval does not match the document hash');

  const audit = { at: now.toISOString(), op: 'debug-restore-requirements', project: paths.id, sha256, approvalSource: prior.source, removedRequests, removedTasks, discardPlanning };
  mkdirSync(paths.ariad, { recursive: true });
  appendFileSync(join(paths.ariad, 'debug-ops.jsonl'), `${JSON.stringify(audit)}\n`);
  return {
    project: paths.id, dbFile: paths.db.split('/').pop(), desiredState: 'STOPPED',
    requirements: { sha256, approvalRestoredFrom: prior.source, approvedBy: prior.record.approvedBy ?? null, approvedAt: prior.record.approvedAt ?? null },
    removedRequests, removedTasks,
    nextStep: 'project start enqueues INITIAL_PLAN only (requirements stage already finalized at this checkpoint)',
  };
}
