import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Guarded database open (2026-11-03 incident): a project's state store
// was zeroed by a role session's file-tool edit, and the watchdog's
// revived daemon then silently initialized the 0-byte file into a fresh
// empty runtime store - the planning state was gone and nothing noticed.
// From now on, opening an EXISTING database file that is empty (0 bytes)
// or fails SQLite integrity_check is a hard failure with a clear code,
// and the failure is recorded in a db-incidents.jsonl sidecar next to
// the database (the store itself may be too damaged to hold the record).
// Only a path that does not exist at all may be created as a new store.

export function recordDbIncident(filePath, code, detail) {
  try {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      kind: 'DB_OPEN_GUARD',
      code,
      file: basename(filePath),
      detail: String(detail ?? ''),
    })}\n`;
    appendFileSync(join(dirname(filePath), 'db-incidents.jsonl'), line, 'utf8');
  } catch { /* best effort: the throw below is the primary signal */ }
}

function guardFailure(code, filePath, detail) {
  recordDbIncident(filePath, code, detail);
  const err = new Error(`${code}: ${detail} (file: ${filePath}). Refusing to open or initialize over an existing damaged store - restore it from a snapshot/backup or archive it deliberately first.`);
  err.code = code;
  throw err;
}

export function openGuardedDatabase(filePath, options = undefined) {
  if (existsSync(filePath)) {
    let size = null;
    try { size = statSync(filePath).size; } catch { size = null; }
    if (size === 0) {
      guardFailure('STORE_DB_EMPTY', filePath, 'existing database file is 0 bytes');
    }
  }
  let db;
  try {
    db = options ? new DatabaseSync(filePath, options) : new DatabaseSync(filePath);
  } catch (e) {
    guardFailure('STORE_DB_CORRUPT', filePath, `SQLite open failed: ${e?.message ?? e}`);
  }
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const values = rows.map(r => Object.values(r)[0]);
    if (!(values.length === 1 && values[0] === 'ok')) {
      try { db.close(); } catch { /* already unusable */ }
      guardFailure('STORE_DB_CORRUPT', filePath, `integrity_check reported: ${values.join('; ').slice(0, 300)}`);
    }
  } catch (e) {
    if (e?.code === 'STORE_DB_CORRUPT' || e?.code === 'STORE_DB_EMPTY') throw e;
    try { db.close(); } catch { /* already unusable */ }
    guardFailure('STORE_DB_CORRUPT', filePath, `integrity_check failed: ${e?.message ?? e}`);
  }
  return db;
}

// Runs integrity_check on an already-open DatabaseSync handle; returns
// null when healthy (or when there is no handle to check) and an error
// string when the store is damaged.
export function integrityErrorOf(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const values = rows.map(r => Object.values(r)[0]);
    if (values.length === 1 && values[0] === 'ok') return null;
    return `integrity_check reported: ${values.join('; ').slice(0, 300)}`;
  } catch (e) {
    return `integrity_check failed: ${e?.message ?? e}`;
  }
}
