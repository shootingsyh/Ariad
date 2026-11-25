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
//
// Transient I/O failures are NOT corruption (2026-11-06 incident): the
// SRPG store repeatedly failed this guard with SQLITE_IOERR ("disk I/O
// error") and with integrity_check reports full of short reads ("unable
// to get the page", error code 522) while the host I/O stack stalled,
// yet the same file passed a full integrity_check from a fresh
// connection minutes later, and a planning batch parked SYSTEM_BLOCKED
// over it. sqlite-store.js already treats SQLITE_IOERR as the signature
// of a stale view on an otherwise healthy WAL file (isDiskIoError,
// 2026-11-01). So an I/O-flavoured failure - a thrown SQLITE_IOERR, or
// a report containing any read-failure line - makes the whole check
// untrustworthy, never proof of damage: the open is retried a bounded
// number of times with backoff. A report with only structural findings
// still hard-fails at once, and if every retry fails the open still
// refuses (health cannot be proven), exactly as before.

export function recordDbIncident(filePath, code, detail, kind = 'DB_OPEN_GUARD') {
  try {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
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

const GUARD_OPEN_ATTEMPTS = 5;
const GUARD_RETRY_DELAYS_MS = [200, 400, 800, 1600];

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* backoff is best effort; an immediate retry still helps */ }
}

// True when an integrity_check report text or an error message carries
// a read-failure signature: SQLITE_IOERR ("disk I/O error"), a page
// that could not be read ("unable to get the page"), or an embedded
// SQLite result code whose primary code (low byte) is 10 (SQLITE_IOERR,
// e.g. 522 SQLITE_IOERR_SHORT_READ, 266 SQLITE_IOERR_READ).
export function isTransientIoText(text) {
  if (!text) return false;
  const s = String(text);
  if (/disk I\/O error/i.test(s)) return true;
  if (/unable to get the page/i.test(s)) return true;
  for (const m of s.matchAll(/error code=(\d+)/g)) {
    if ((Number(m[1]) & 0xff) === 10) return true;
  }
  return false;
}

// True when a thrown SQLite error is an I/O failure rather than a
// statement about the database contents. Mirrors the isDiskIoError
// doctrine in sqlite-store.js; kept local to avoid an import cycle
// (sqlite-store.js imports openGuardedDatabase from this module).
export function isTransientIoError(error) {
  if (!error) return false;
  const code = error.errcode ?? error.code;
  if (typeof code === 'number' && (code & 0xff) === 10) return true;
  const message = error instanceof Error ? error.message : String(error);
  return isTransientIoText(message);
}

// Read-only integrity verdict for an existing database file. Opens the
// file with readOnly: true, so the check itself can never run WAL
// recovery, checkpoint, or truncate anything (2026-11-25 post-mortem:
// the previous guard opened read-write and closed the handle after
// every failed attempt; each close checkpointed the WAL of a database
// whose health was still unknown, destroying the very data the check
// was meant to protect). States: 'ok' | 'structural' (the file itself
// is damaged) | 'transient' (I/O-flavoured failure; the verdict is
// untrustworthy, retry) | 'needs-rw' (a cold WAL the read-only open
// cannot recover: SQLITE_CANTOPEN, e.g. wal present but no shm).
function readOnlyIntegrityVerdict(filePath) {
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch (e) {
    if (isTransientIoError(e)) {
      return { state: 'transient', detail: `SQLite read-only open failed: ${e?.message ?? e}` };
    }
    const msg = String(e?.message ?? e);
    const errcode = typeof e?.errcode === 'number' ? (e.errcode & 0xff) : null;
    if (errcode === 14 || /unable to open database file/i.test(msg)) {
      return { state: 'needs-rw', detail: `read-only open cannot recover this file: ${msg}` };
    }
    return { state: 'structural', detail: `SQLite read-only open failed: ${msg}` };
  }
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const values = rows.map(r => Object.values(r)[0]);
    if (values.length === 1 && values[0] === 'ok') return { state: 'ok' };
    const joined = values.join('; ');
    if (isTransientIoText(joined)) {
      return { state: 'transient', detail: `integrity_check reported: ${joined.slice(0, 300)}` };
    }
    return { state: 'structural', detail: `integrity_check reported: ${joined.slice(0, 300)}` };
  } catch (e) {
    if (isTransientIoError(e) || isTransientIoText(e?.message ?? '')) {
      return { state: 'transient', detail: `integrity_check failed: ${e?.message ?? e}` };
    }
    return { state: 'structural', detail: `integrity_check failed: ${e?.message ?? e}` };
  } finally {
    try { db.close(); } catch { /* read-only close: no checkpoint, nothing at stake */ }
  }
}

export function openGuardedDatabase(filePath, options = undefined) {
  const exists = existsSync(filePath);
  if (exists) {
    let size = null;
    try { size = statSync(filePath).size; } catch { size = null; }
    if (size === 0) {
      guardFailure('STORE_DB_EMPTY', filePath, 'existing database file is 0 bytes');
    }
  }
  if (!exists) {
    // A path that does not exist at all is the only file a caller may
    // initialize as a new store.
    return options ? new DatabaseSync(filePath, options) : new DatabaseSync(filePath);
  }
  if (options?.readOnly) {
    const verdict = readOnlyIntegrityVerdict(filePath);
    if (verdict.state === 'ok') return new DatabaseSync(filePath, options);
    guardFailure('STORE_DB_CORRUPT', filePath, verdict.detail);
  }
  // Verify BEFORE opening read-write: until the file is proven healthy,
  // no read-write handle is ever opened on it, so nothing can checkpoint
  // or truncate its WAL while its health is unknown (2026-11-25).
  let lastTransientDetail = null;
  let verified = false;
  for (let attempt = 0; attempt < GUARD_OPEN_ATTEMPTS; attempt++) {
    if (attempt > 0) sleepSync(GUARD_RETRY_DELAYS_MS[attempt - 1] ?? 1600);
    const verdict = readOnlyIntegrityVerdict(filePath);
    if (verdict.state === 'ok') { verified = true; break; }
    if (verdict.state === 'structural') {
      guardFailure('STORE_DB_CORRUPT', filePath, verdict.detail);
    }
    if (verdict.state === 'needs-rw') {
      // Cold WAL a read-only open cannot recover. Fall back to the
      // legacy read-write guarded open, and record that the safe path
      // was unavailable for this file.
      recordDbIncident(filePath, 'STORE_DB_RO_FALLBACK', verdict.detail);
      return openGuardedDatabaseLegacy(filePath, options);
    }
    lastTransientDetail = verdict.detail;
  }
  if (!verified) {
    guardFailure('STORE_DB_CORRUPT', filePath, `${lastTransientDetail ?? 'integrity_check failed'} (transient I/O failure persisted across ${GUARD_OPEN_ATTEMPTS} read-only check attempts)`);
  }
  if (lastTransientDetail) {
    recordDbIncident(filePath, 'STORE_DB_TRANSIENT_IO', `read-only integrity check passed after transient I/O failure (${lastTransientDetail})`);
  }
  // The file was proven healthy moments ago by the read-only check, in
  // this same synchronous process; nothing else opened it in between.
  return options ? new DatabaseSync(filePath, options) : new DatabaseSync(filePath);
}

function openGuardedDatabaseLegacy(filePath, options = undefined) {
  if (existsSync(filePath)) {
    let size = null;
    try { size = statSync(filePath).size; } catch { size = null; }
    if (size === 0) {
      guardFailure('STORE_DB_EMPTY', filePath, 'existing database file is 0 bytes');
    }
  }
  let lastTransientDetail = null;
  for (let attempt = 0; attempt < GUARD_OPEN_ATTEMPTS; attempt++) {
    if (attempt > 0) sleepSync(GUARD_RETRY_DELAYS_MS[attempt - 1] ?? 1600);
    let db;
    try {
      db = options ? new DatabaseSync(filePath, options) : new DatabaseSync(filePath);
    } catch (e) {
      if (isTransientIoError(e)) {
        lastTransientDetail = `SQLite open failed: ${e?.message ?? e}`;
        continue;
      }
      guardFailure('STORE_DB_CORRUPT', filePath, `SQLite open failed: ${e?.message ?? e}`);
    }
    try {
      const rows = db.prepare('PRAGMA integrity_check').all();
      const values = rows.map(r => Object.values(r)[0]);
      if (values.length === 1 && values[0] === 'ok') {
        if (lastTransientDetail) {
          recordDbIncident(filePath, 'STORE_DB_TRANSIENT_IO', `integrity check passed on attempt ${attempt + 1} after transient I/O failure (${lastTransientDetail})`);
        }
        return db;
      }
      const joined = values.join('; ');
      try { db.close(); } catch { /* already unusable */ }
      if (isTransientIoText(joined)) {
        lastTransientDetail = `integrity_check reported: ${joined.slice(0, 300)}`;
        continue;
      }
      guardFailure('STORE_DB_CORRUPT', filePath, `integrity_check reported: ${joined.slice(0, 300)}`);
    } catch (e) {
      if (e?.code === 'STORE_DB_CORRUPT' || e?.code === 'STORE_DB_EMPTY') throw e;
      try { db.close(); } catch { /* already unusable */ }
      if (isTransientIoError(e) || isTransientIoText(e?.message ?? '')) {
        lastTransientDetail = `integrity_check failed: ${e?.message ?? e}`;
        continue;
      }
      guardFailure('STORE_DB_CORRUPT', filePath, `integrity_check failed: ${e?.message ?? e}`);
    }
  }
  guardFailure('STORE_DB_CORRUPT', filePath, `${lastTransientDetail ?? 'integrity_check failed'} (transient I/O failure persisted across ${GUARD_OPEN_ATTEMPTS} open attempts)`);
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
