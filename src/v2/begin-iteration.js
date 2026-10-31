import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SQLiteV2Store } from './sqlite-store.js';
import { VersionedStore, DELIVERY_KINDS } from './versioned-store.js';
import { seedLegacyFromOldDb } from './legacy-seed.js';

// begin-iteration: the system-side head of an iteration (replan) cycle.
// It archives the project's current store, creates a fresh DB-first
// store, seeds its legacy zone from the old store, creates the project
// record in the new store, and flips the project's dbFile pointer.
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

function nextDbFileName(currentFile) {
  const m = basename(currentFile).match(/^state(\d*)\.db$/);
  if (!m) return 'state2.db';
  const n = m[1] === '' ? 2 : Number(m[1]) + 1;
  return `state${n}.db`;
}

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

  if (project.desiredState !== 'STOPPED') {
    fail('ITERATION_PROJECT_NOT_STOPPED', `project ${paths.id} desiredState is ${project.desiredState ?? 'unset'}; stop the project before beginning an iteration`);
  }
  if (inFlight.length) {
    fail('ITERATION_DELIVERY_IN_FLIGHT', `delivery tasks still in flight: ${inFlight.join(', ')}`);
  }

  const newDbFile = dbFile ?? nextDbFileName(oldDbPath);
  if (basename(newDbFile) !== newDbFile || !newDbFile.endsWith('.db')) {
    fail('ITERATION_BAD_DB_FILE', `--db-file must be a plain .db file name, got ${newDbFile}`);
  }
  const newDbPath = join(paths.ariad, newDbFile);
  if (existsSync(newDbPath)) fail('ITERATION_TARGET_EXISTS', `target store already exists: ${newDbPath}`);

  const archive = archiveStore({ oldDbPath, workspace: paths.workspace, projectId: project.id, now });

  let seeded;
  try {
    const runtime = new SQLiteV2Store(newDbPath);
    try {
      runtime.createProject({
        ...project, versionedTree: true, unifiedTaskCompilerVersion: 1,
        desiredState: 'STOPPED', executionState: 'IDLE',
      });
    } finally { runtime.db.close(); }
    const versioned = new VersionedStore(newDbPath);
    try {
      if (!versioned.projectId) versioned.initProject(project.id);
      const old = new DatabaseSync(oldDbPath, { readOnly: true });
      try { seeded = seedLegacyFromOldDb(old, versioned, project.id); } finally { old.close(); }
    } finally { versioned.close(); }
  } catch (err) {
    rmSync(newDbPath, { force: true });
    rmSync(`${newDbPath}-wal`, { force: true });
    rmSync(`${newDbPath}-shm`, { force: true });
    throw err;
  }

  // Flip the pointer last: before this line the project still resolves
  // to the old store and nothing about the running setup has changed.
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

  return {
    project: paths.id,
    projectId: project.id,
    previousDb: basename(oldDbPath),
    newDbFile,
    archiveDir: archive.dir,
    archiveSha256: archive.manifest.sha256,
    seeded,
    pointer,
    nextSteps: [
      'restart the daemon so it opens the new store',
      'PM authors the new version requirements in .ariad/docs/REQUIREMENTS.md and a human approves them (ariad project approve-requirements)',
      'start a planning request: TL rebuilds the tree into a DB draft via ariad_tree_patch, PM promotes on PLAN_ACCEPTED',
      'resume the project when the new tree is promoted',
    ],
  };
}
