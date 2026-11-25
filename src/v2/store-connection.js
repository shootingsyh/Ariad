import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openGuardedDatabase, recordDbIncident } from './db-open-guard.js';

// Shared store connections (owner decision, 2026-11-25, after the SRPG
// state.db corruption post-mortem). One process holds AT MOST ONE
// read-write connection per database file: every store built over the
// same file (runtime store, versioned store, reconcile signal, ad-hoc
// payload readers) acquires a reference to the same connection box and
// reads the live handle through it, so a reopen swaps the handle for
// everyone at once and no second connection ever cycles the WAL under
// the first one's feet. SQLite serializes writers anyway; extra
// connections bought only lock contention and WAL bookkeeping forks.
//
// Boxes are keyed by resolved path: a store follows its path (the
// dbFile pointer is the project's resolution contract), and a flow
// that replaces the file at a path (begin-iteration) invalidates the
// box explicitly so the next acquire opens the new file.
// ':memory:' databases are never shared: each acquire is a private
// universe, exactly as a raw DatabaseSync(':memory:') was.
//
// reopenStoreConnection is the only sanctioned way to drop and
// re-establish the handle, and it is built to be non-destructive:
//   1. snapshot the db/-wal/-shm trio first (the pre-reopen state stays
//      recoverable no matter what happens next);
//   2. close the old handle and VERIFY it is really closed - a close
//      that throws while the handle still works aborts the reopen, so
//      a zombie connection can never coexist with its replacement;
//   3. open the replacement through the guarded open (which now proves
//      integrity read-only before any read-write handle exists);
//   4. if the open fails, restore the snapshot trio byte-for-byte and
//      latch the box faulted: every later acquire/reopen throws the
//      recorded failure without touching the files again, until the
//      last holder releases the box (e.g. process restart re-verifies
//      from scratch).

const boxes = new Map();
const MAX_PREREOPEN_SNAPSHOTS = 3;

function keyOf(file) {
  if (file === ':memory:') return null;
  return resolve(file);
}

export function acquireStoreConnection(file) {
  if (!file) throw new Error('acquireStoreConnection requires a database file path');
  const key = keyOf(file);
  if (key === null) {
    return { file, key: null, handle: null, refs: 1, generation: 0, faulted: null };
  }
  let box = boxes.get(key);
  if (!box) {
    box = { file, key, handle: null, refs: 0, generation: 0, faulted: null };
    boxes.set(key, box);
  }
  if (box.faulted) throw box.faulted;
  box.refs += 1;
  return box;
}

// Returns the box's live handle, opening it (guarded) when needed.
// initHandle runs whenever the handle generation changes for this
// caller: track the generation you last initialized in the caller and
// pass it back; the updated generation is returned. A handle that died
// underneath the box (a legacy call site closed it directly) is NOT
// silently replaced: operations on it fail loudly, and reopen() is
// the recovery path - the same doctrine the stores always had.
export function ensureStoreHandle(box, lastGeneration, initHandle) {
  if (box.faulted) throw box.faulted;
  if (!box.handle) {
    box.handle = openGuardedDatabase(box.file);
    box.generation += 1;
  }
  if (lastGeneration !== box.generation) {
    if (initHandle) initHandle(box.handle);
    return box.generation;
  }
  return lastGeneration;
}

// Drops the box registered for a file (closing its handle) WITHOUT
// touching the file itself. For flows that replace the file at a path
// wholesale (begin-iteration archives and deletes the old generation,
// then creates a new store at the same path): holders of the orphaned
// box fail loudly on the dead handle, and the next acquire opens the
// new file.
export function invalidateStoreConnection(file) {
  if (!file || file === ':memory:') return;
  const key = resolve(file);
  const box = boxes.get(key);
  if (!box) return;
  boxes.delete(key);
  if (box.handle) {
    try { box.handle.close(); } catch { /* already dead */ }
    box.handle = null;
  }
}

// Construction-time open: a store being built over a box whose handle
// died (a predecessor holder closed it directly) replaces the corpse
// with a fresh guarded handle instead of initializing over a dead one.
// This is deliberately NOT done on the operation path (ensureStore
// Handle): a handle that dies under live stores fails loudly there,
// and reopen() is the recovery.
export function openStoreHandle(box, initHandle) {
  if (box.faulted) throw box.faulted;
  if (box.handle && box.handle.isOpen === false) box.handle = null;
  if (!box.handle) {
    box.handle = openGuardedDatabase(box.file);
    box.generation += 1;
  }
  if (initHandle) initHandle(box.handle);
  return box.generation;
}

export function releaseStoreConnection(box) {
  if (!box) return;
  if (box.refs > 0) box.refs -= 1;
  if (box.refs > 0) return;
  if (box.handle) {
    // Last holder: a plain close. SQLite folds the WAL as part of a
    // normal close; no explicit checkpoint/TRUNCATE ever runs here.
    try { box.handle.close(); } catch { /* a dead handle at teardown is harmless */ }
    box.handle = null;
  }
  if (box.key !== null && boxes.get(box.key) === box) boxes.delete(box.key);
}

function snapshotStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Copies the db/-wal/-shm trio into <dir>/snapshots/ and returns the
// snapshot's main-file path (null when the database file itself does
// not exist). Prunes to the newest MAX_PREREOPEN_SNAPSHOTS snapshots.
export function snapshotStoreFiles(file, tag = 'prereopen') {
  if (!existsSync(file)) return null;
  const dir = join(dirname(file), 'snapshots');
  mkdirSync(dir, { recursive: true });
  const base = `state-${tag}-${snapshotStamp()}.db`;
  const target = join(dir, base);
  copyFileSync(file, target);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(file + suffix)) copyFileSync(file + suffix, target + suffix);
  }
  try {
    const mine = readdirSync(dir)
      .filter(name => name.startsWith(`state-${tag}-`) && name.endsWith('.db'))
      .sort();
    for (const name of mine.slice(0, Math.max(0, mine.length - MAX_PREREOPEN_SNAPSHOTS))) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(join(dir, name + suffix), { force: true }); } catch { /* best effort */ }
      }
    }
  } catch { /* pruning is best effort */ }
  return target;
}

// Restores a trio previously taken by snapshotStoreFiles over the live
// paths. Callers must hold no open handle on the file.
export function restoreStoreFiles(file, snapshot) {
  if (!snapshot || !existsSync(snapshot)) return false;
  copyFileSync(snapshot, file);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(snapshot + suffix)) copyFileSync(snapshot + suffix, file + suffix);
    else rmSync(file + suffix, { force: true });
  }
  return true;
}

function reasonText(reason) {
  if (!reason) return 'no reason given';
  const msg = reason instanceof Error ? reason.message : String(reason);
  return msg.slice(0, 200);
}

export function reopenStoreConnection(box, reason = null) {
  if (box.faulted) throw box.faulted;
  const snapshot = snapshotStoreFiles(box.file, 'prereopen');
  recordDbIncident(box.file, 'STORE_REOPEN',
    `reopening shared connection (reason: ${reasonText(reason)}); pre-reopen snapshot: ${snapshot ?? 'none (file absent)'}`,
    'STORE_CONNECTION');
  const old = box.handle;
  if (old) {
    let closed = false;
    try { old.close(); closed = true; } catch { /* verified below */ }
    if (!closed) {
      // A throwing close may still have closed the handle; only a
      // handle that still answers is a zombie we must not replace.
      try { old.prepare('SELECT 1').get(); } catch { closed = true; }
    }
    if (!closed) {
      recordDbIncident(box.file, 'STORE_REOPEN_ABORTED',
        'existing connection would not close and still answers; refusing to open a second connection over it',
        'STORE_CONNECTION');
      const err = new Error('STORE_REOPEN_ABORTED: existing connection would not close; refusing to open a second connection over it');
      err.code = 'STORE_REOPEN_ABORTED';
      throw err;
    }
    box.handle = null;
  }
  try {
    box.handle = openGuardedDatabase(box.file);
    box.generation += 1;
  } catch (e) {
    restoreStoreFiles(box.file, snapshot);
    box.faulted = e;
    recordDbIncident(box.file, 'STORE_REOPEN_FAILED',
      `guarded reopen failed (${reasonText(e)}); pre-reopen snapshot restored, connection latched faulted`,
      'STORE_CONNECTION');
    throw e;
  }
  return box.handle;
}
