import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteV2Store } from './sqlite-store.js';
import { VersionedStore } from './versioned-store.js';

// Shared fresh-store builder for the two operator/system entrances
// that must birth a DB-first project store at the fixed live path:
// begin-iteration (after archiving the previous generation elsewhere)
// and `project debug-restore-requirements --fresh-store` (when the
// store file is missing entirely). Keeping the construction in one
// place prevents the two paths from drifting on the project-row shape:
// the row is seeded from the workspace manifest (or an explicit seed
// project, for begin-iteration's archived row), always versioned,
// always born STOPPED/IDLE with the delivery gate closed.
function fail(code, message) {
  const err = new Error(code + ': ' + message);
  err.code = code;
  throw err;
}

const parseJson = (text, file) => {
  try { return JSON.parse(text); } catch (err) {
    fail('FRESH_STORE_JSON_INVALID', 'cannot parse ' + file + ': ' + (err?.message ?? err));
  }
};

export const FRESH_STORE_DB_FILE = 'state.db';

function readManifestSeed(paths) {
  if (!paths.manifest || !existsSync(paths.manifest)) {
    fail('FRESH_STORE_MANIFEST_MISSING', 'no project manifest at ' + (paths.manifest ?? '<unknown>'));
  }
  return parseJson(readFileSync(paths.manifest, 'utf8'), paths.manifest);
}

function projectRecord({ paths, seed }) {
  const source = seed && typeof seed === 'object' ? seed : {};
  const record = { ...source };
  delete record.version;
  delete record.updatedAt;
  delete record.root;
  delete record.stateDb;
  delete record.dbFile;
  return {
    ...record,
    id: paths.id ?? source.id,
    goal: source.goal ?? null,
    spec: source.spec ?? source.goal ?? null,
    mode: source.mode ?? 'NEW',
    sourcePath: source.sourcePath ?? null,
    workspace: paths.workspace ?? source.workspace,
    versionedTree: true,
    unifiedTaskCompilerVersion: 1,
    deliveryEnabled: false,
    desiredState: 'STOPPED',
    executionState: 'IDLE',
  };
}

function pinProjectDbFile({ paths, dbFile }) {
  if (paths.adopted) {
    const refFile = paths.adoptedRef;
    if (!refFile) fail('FRESH_STORE_REF_MISSING', 'adopted project has no project-ref.json path');
    const ref = existsSync(refFile)
      ? parseJson(readFileSync(refFile, 'utf8'), refFile)
      : { id: paths.id, workspace: paths.workspace };
    ref.dbFile = dbFile;
    writeFileSync(refFile, JSON.stringify(ref, null, 2) + '\n', 'utf8');
    return 'project-ref.json';
  }
  if (paths.manifest) {
    const manifest = existsSync(paths.manifest)
      ? parseJson(readFileSync(paths.manifest, 'utf8'), paths.manifest)
      : {};
    manifest.dbFile = dbFile;
    writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return 'project.json';
  }
  return null;
}

export function createFreshProjectStore({
  paths,
  project = null,
  seed = null,
  dbFile = FRESH_STORE_DB_FILE,
  pinPointer = true,
} = {}) {
  if (!paths?.ariad || !paths?.id) {
    fail('FRESH_STORE_PATHS_REQUIRED', 'project paths with ariad and id are required');
  }
  if (!dbFile || dbFile.includes('/') || dbFile.includes('\\')) {
    fail('FRESH_STORE_DB_FILE_INVALID', 'dbFile must be a plain file name, got ' + String(dbFile));
  }
  const dbPath = join(paths.ariad, dbFile);
  if (existsSync(dbPath)) {
    fail('FRESH_STORE_DB_EXISTS', 'a store already exists at ' + dbPath + '; refusing to build over it');
  }
  const source = project ?? seed ?? readManifestSeed(paths);
  const record = projectRecord({ paths, seed: source });
  if (!record.id) fail('FRESH_STORE_PROJECT_ID_MISSING', 'project id is required');

  let runtime = null;
  let versioned = null;
  try {
    mkdirSync(paths.ariad, { recursive: true });
    runtime = new SQLiteV2Store(dbPath);
    const created = runtime.createProject(record);
    try { runtime.db.close(); } catch { /* best effort close */ }
    runtime = null;

    versioned = new VersionedStore(dbPath);
    const existingProjectId = versioned.projectId;
    if (!existingProjectId) versioned.initProject(record.id);
    else if (existingProjectId !== record.id) {
      fail('FRESH_STORE_PROJECT_ID_MISMATCH',
        'versioned meta project_id is ' + existingProjectId + ', not ' + record.id);
    }
    try { versioned.close(); } catch { /* best effort close */ }
    versioned = null;

    const pointer = pinPointer ? pinProjectDbFile({ paths, dbFile }) : null;
    return { project: created, projectId: record.id, dbPath, dbFile, pointer };
  } catch (err) {
    if (runtime) { try { runtime.db?.close(); } catch { /* already unusable */ } }
    if (versioned) { try { versioned.close(); } catch { /* already unusable */ } }
    // No half-built store may survive a failed fresh build: the caller
    // (and its guards) must see the same missing-store state as before.
    for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm', dbPath + '-journal']) {
      rmSync(file, { force: true });
    }
    throw err;
  }
}
