import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SQLiteV2Store } from './sqlite-store.js';
import { VersionedStore, DELIVERY_KINDS } from './versioned-store.js';
import { writeInventoryArtifact } from './inventory-artifact.js';
import { approvalsPath } from './project-docs.js';
import { ensureAriadGitignore, ensureWorkspaceGitignore } from '../runtime/workspace-ignore.js';

// begin-iteration: the system-side head of an iteration (replan) cycle.
// It archives the project's current store, creates a fresh DB-first
// store AT THE SAME fixed path (.ariad/state.db - the live store's
// name never changes; owner ruling 2026-11-03), writes a plain-file
// inventory of the old store under
// .ariad/artifacts/inventory/ (what it holds, what its schema looks
// like - documentation for the PM/TL to discover from, never an
// import), creates the project record in the new store, and pins the
// project's dbFile pointer at the fixed name.
// The rebuild itself is NOT done here: PM authors/approves the version
// requirements and TL replans into a draft inside Ariad afterwards.
//
// Guards: the project must be STOPPED and no delivery task may be in
// flight; the old store is only ever read (plus a WAL checkpoint and a
// VACUUM INTO snapshot for the archive), never written with new state.
function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  throw err;
}
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// The live store's file name is FIXED (owner ruling 2026-11-03): it is
// always state.db. The generation-counter naming (state2.db, state3.db,
// ...) is abolished - previous generations live only as archives under
// backups/. Any legacy pointer (e.g. state2.db) is migrated to the fixed
// name by the begin-iteration that replaces it.
export const LIVE_DB_FILE = 'state.db';

function archiveStore({ oldDbPath, workspace, projectId, now }) {
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
  let dir = join(workspace, 'backups', `pre-iterate-${stamp}`);
  for (let i = 2; existsSync(dir); i++) dir = join(workspace, 'backups', `pre-iterate-${stamp}-${i}`);
  mkdirSync(dir, { recursive: true });
  const archiveDbPath = join(dir, 'state.db');
  const src = new DatabaseSync(oldDbPath);
  try {
    try { src.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* best effort; VACUUM INTO is itself consistent */ }
    src.exec(`VACUUM INTO '${archiveDbPath.replace(/'/g, "''")}'`);
  } finally { src.close(); }

  const counts = {};
  let total = 0;
  const arc = new DatabaseSync(archiveDbPath, { readOnly: true });
  try {
    const rows = arc.prepare('SELECT data_json FROM v2_tasks WHERE project_id = ?').all(projectId)
      .map(r => parse(r.data_json)).filter(t => DELIVERY_KINDS.includes(t.taskKind));
    total = rows.length;
    for (const t of rows) counts[t.state ?? 'UNKNOWN'] = (counts[t.state ?? 'UNKNOWN'] ?? 0) + 1;
  } finally { arc.close(); }

  let gitHead = null;
  try { gitHead = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null; } catch { gitHead = null; }
  const requirementsPath = join(workspace, '.ariad', 'docs', 'REQUIREMENTS.md');
  const manifest = {
    kind: 'pre-iterate-archive',
    projectId,
    archivedAt: now.toISOString(),
    sourceDb: oldDbPath,
    archiveFile: 'state.db',
    sha256: sha256File(archiveDbPath),
    deliveryStateCounts: counts,
    deliveryTotal: total,
    gitHead,
    requirementsHash: existsSync(requirementsPath) ? sha256File(requirementsPath) : null,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { dir, manifest };
}

export function beginIteration({ manager, name, dbFile = null, now = new Date() }) {
  if (!manager) fail('ITERATION_MANAGER_REQUIRED', 'an AriadProjectManager is required');
  const paths = manager.resolveProjectPaths(name);
  const oldDbPath = paths.db;
  if (!existsSync(oldDbPath)) fail('ITERATION_OLD_DB_MISSING', `no store at ${oldDbPath}`);

  const ro = new DatabaseSync(oldDbPath, { readOnly: true });
  let project; let inFlight;
  try {
    const rows = ro.prepare('SELECT id, data_json FROM v2_projects').all();
    const row = rows.find(r => r.id === paths.id) ?? (rows.length === 1 ? rows[0] : null);
    if (!row) fail('ITERATION_PROJECT_RECORD_MISSING', `no project record for ${paths.id} in ${oldDbPath}`);
    project = { ...parse(row.data_json), id: row.id };
    const tasks = ro.prepare('SELECT id, data_json FROM v2_tasks WHERE project_id = ?').all(row.id)
      .map(r => ({ ...parse(r.data_json), id: r.id }));
    inFlight = tasks.filter(t => DELIVERY_KINDS.includes(t.taskKind) && ['WORKING', 'RESULT_READY'].includes(t.state)).map(t => t.id);
  } finally { ro.close(); }

  let desiredState;
  try { desiredState = manager.status(name)?.desiredState; } catch { desiredState = undefined; }
  desiredState ??= project.desiredState;
  if (desiredState !== 'STOPPED') {
    fail('ITERATION_PROJECT_NOT_STOPPED', `project ${paths.id} desiredState is ${desiredState ?? 'unset'}; stop the project before beginning an iteration`);
  }
  if (inFlight.length) {
    fail('ITERATION_DELIVERY_IN_FLIGHT', `delivery tasks still in flight: ${inFlight.join(', ')}`);
  }

  if (dbFile != null && dbFile !== LIVE_DB_FILE) {
    fail('ITERATION_DB_FILE_FIXED', `the live store file name is fixed as ${LIVE_DB_FILE}; --db-file ${dbFile} is not accepted (previous generations are archived under backups/, never renamed forward)`);
  }
  const newDbFile = LIVE_DB_FILE;
  const newDbPath = join(paths.ariad, newDbFile);

  ensureAriadGitignore(paths.ariad);
  ensureWorkspaceGitignore(paths.workspace);

  const archive = archiveStore({ oldDbPath, workspace: paths.workspace, projectId: project.id, now });

  // The old store is fully archived above (VACUUM INTO snapshot +
  // manifest), so its live files are retired now: the new store is
  // created at the fixed path .ariad/state.db. When the outgoing store
  // lived at a legacy name (state2.db) and a still older state.db file
  // is lying around, that stale file is preserved inside the archive
  // as superseded-state.db rather than silently overwritten.
  if (newDbPath !== oldDbPath && existsSync(newDbPath)) {
    renameSync(newDbPath, join(archive.dir, 'superseded-state.db'));
  }
  for (const f of [oldDbPath, `${oldDbPath}-wal`, `${oldDbPath}-shm`, `${oldDbPath}-journal`,
    `${newDbPath}-wal`, `${newDbPath}-shm`, `${newDbPath}-journal`]) {
    rmSync(f, { force: true });
  }
  if (newDbPath !== oldDbPath) rmSync(oldDbPath, { force: true });

  // Planner artifacts are the pre-DB-first plan medium: the new store's
  // drafts replace them, and leaving the old bundle in the workspace
  // keeps legacy readers validating a previous generation's plan (a
  // stale V2.1 taskLink parked SRPG's first DB-first iteration). Archive
  // the bundle with the store snapshot; the workspace starts clean.
  let plannerArtifactsArchived = false;
  const plannerArtifactsDir = join(paths.workspace, '.ariad', 'artifacts', 'planner');
  if (existsSync(plannerArtifactsDir)) {
    renameSync(plannerArtifactsDir, join(archive.dir, 'planner-artifacts'));
    plannerArtifactsArchived = true;
  }

  // The requirements document itself stays in the workspace: the PM
  // revises the previous version's document in place rather than
  // regenerating it. Its APPROVAL does not carry across generations -
  // the record pins the previous document's hash, and an unchanged
  // document would otherwise read as approved and skip the PM stage
  // entirely. Archive the record with the store snapshot; the revised
  // document needs a fresh human approval this iteration.
  let requirementsApprovalArchived = false;
  const approvalsFile = approvalsPath(paths.workspace);
  if (existsSync(approvalsFile)) {
    renameSync(approvalsFile, join(archive.dir, 'requirements-approvals.json'));
    requirementsApprovalArchived = true;
  }

  let sessionsArchived = 0;
  const persistentDir = join(paths.workspace, '.ariad', 'pi', 'sessions', 'persistent');
  if (existsSync(persistentDir)) {
    const entries = readdirSync(persistentDir);
    if (entries.length) {
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const archiveTo = join(paths.workspace, '.ariad', 'pi', 'session-archive', stamp, 'persistent');
      mkdirSync(join(archiveTo, '..'), { recursive: true });
      renameSync(persistentDir, archiveTo);
      sessionsArchived = entries.length;
    }
  }

  let inventory;
  try {
    const runtime = new SQLiteV2Store(newDbPath);
    try {
      runtime.createProject({
        ...project, versionedTree: true, unifiedTaskCompilerVersion: 1,
        desiredState: 'STOPPED', executionState: 'IDLE', deliveryEnabled: false,
      });
    } finally { runtime.db.close(); }
    const versioned = new VersionedStore(newDbPath);
    try {
      if (!versioned.projectId) versioned.initProject(project.id);
    } finally { versioned.close(); }
    // The inventory is documentation, not a migration: its failure must
    // not block the cutover (the archive still holds the full record),
    // so a failure is reported in the result instead of thrown.
    const old = new DatabaseSync(join(archive.dir, 'state.db'), { readOnly: true });
    try {
      inventory = writeInventoryArtifact({ db: old, workspace: paths.workspace, project, oldDbPath, archiveDir: archive.dir, now });
    } catch (err) {
      inventory = { dir: '.ariad/artifacts/inventory', error: String(err?.message ?? err) };
    } finally { old.close(); }
  } catch (err) {
    rmSync(newDbPath, { force: true });
    rmSync(`${newDbPath}-wal`, { force: true });
    rmSync(`${newDbPath}-shm`, { force: true });
    throw err;
  }

  // Pin the pointer at the fixed name last: before this line the
  // project still resolves to the old store and nothing about the
  // running setup has changed.
  let pointer;
  if (paths.adopted) {
    const ref = JSON.parse(readFileSync(paths.adoptedRef, 'utf8'));
    ref.dbFile = newDbFile;
    writeFileSync(paths.adoptedRef, `${JSON.stringify(ref, null, 2)}\n`, 'utf8');
    pointer = 'project-ref.json';
  } else {
    const manifest = existsSync(paths.manifest) ? JSON.parse(readFileSync(paths.manifest, 'utf8')) : {};
    manifest.dbFile = newDbFile;
    writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    pointer = 'project.json';
  }

  // Best-effort: a project without a readable manifest must not fail
  // the iteration over the auxiliary reset (its store row already
  // carries IDLE, and the manifest is recreated on first write).
  if (typeof manager.writeManifest === 'function') {
    try { manager.writeManifest(name, { executionState: 'IDLE' }); } catch { /* no manifest to reset */ }
  }

  return {
    project: paths.id,
    projectId: project.id,
    previousDb: basename(oldDbPath),
    newDbFile,
    archiveDir: archive.dir,
    archiveSha256: archive.manifest.sha256,
    inventory,
    sessionsArchived,
    plannerArtifactsArchived,
    requirementsApprovalArchived,
    pointer,
    nextSteps: [
      'restart the daemon so it opens the new store',
      'PM authors the new version requirements in .ariad/docs/REQUIREMENTS.md and a human approves them (ariad project approve-requirements)',
      'start a planning request: TL rebuilds the tree into a DB draft via ariad_tree_patch, PM promotes on PLAN_ACCEPTED',
      'resume the project when the new tree is promoted',
    ],
  };
}
