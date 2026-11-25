import { acquireStoreConnection, ensureStoreHandle, openStoreHandle, releaseStoreConnection, reopenStoreConnection } from './store-connection.js';

function isDeadHandleError(e) {
  if (!e) return false;
  if (e.code === 'ERR_INVALID_STATE') return true;
  return /database is not open/i.test(String(e?.message ?? e));
}

const DURABLE_TABLES = [
  'v2_projects',
  'v2_tasks',
  'v2_planning_requests',
  'v2_system_incidents',
];

// Reconcile generation signal. Shares the project's one store
// connection through the connection box (store-connection.js): the
// signal never opens, closes, or reopens a connection of its own. It
// used to cycle a private handle on any read error (2026-11-01: a
// stale signal handle froze reconcile while the file was healthy);
// with the shared box, a reopen performed by the store layer swaps the
// handle for the signal too, and a genuine failure propagates to the
// caller, which already tolerates an unreadable signal. The generation
// itself is advanced by mutation triggers on the durable tables, so
// writes through ANY store over this file are counted.
export class SQLiteReconcileSignal {
  #box = null;
  #gen = 0;
  #released = false;

  constructor(file) {
    if (!file) throw new Error('SQLiteReconcileSignal requires a database file path');
    this.file = file;
    this.#box = acquireStoreConnection(file);
    this.#gen = openStoreHandle(this.#box, (db) => this.#initHandle(db));
  }

  get db() {
    if (this.#released || !this.#box) return null;
    this.#syncHandle();
    return this.#box.handle;
  }

  #syncHandle() {
    this.#gen = ensureStoreHandle(this.#box, this.#gen, (db) => this.#initHandle(db));
  }

  #initHandle(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS v2_reconcile_signal (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO v2_reconcile_signal (singleton, generation, updated_at)
      VALUES (1, 0, CURRENT_TIMESTAMP);
    `);
    this.#installMutationTriggers(db);
  }

  #installMutationTriggers(db) {
    const tableExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    );
    for (const table of DURABLE_TABLES) {
      if (!tableExists.get(table)) continue;
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const trigger = `ariad_reconcile_${table}_${operation.toLowerCase()}`;
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS ${trigger}
          AFTER ${operation} ON ${table}
          BEGIN
            UPDATE v2_reconcile_signal
            SET generation = generation + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE singleton = 1;
          END;
        `);
      }
    }
  }

  read() {
    try {
      return this.#readOnce();
    } catch (e) {
      if (!isDeadHandleError(e) || !this.#box) throw e;
      // The shared handle died underneath the box (a legacy call site
      // closed it directly): recover through the one sanctioned,
      // snapshot-gated reopen and retry once. Any other failure is a
      // real store problem and propagates to the caller.
      reopenStoreConnection(this.#box, e);
      this.#syncHandle();
      return this.#readOnce();
    }
  }

  #readOnce() {
    // Stores may create/migrate durable tables after this signal is
    // opened; refreshing trigger installation keeps upgrades zero-touch.
    const db = this.db;
    this.#installMutationTriggers(db);
    return Number(db.prepare(
      'SELECT generation FROM v2_reconcile_signal WHERE singleton = 1'
    ).get().generation);
  }

  bump() {
    try {
      this.#bumpOnce();
    } catch (e) {
      if (!isDeadHandleError(e) || !this.#box) throw e;
      reopenStoreConnection(this.#box, e);
      this.#syncHandle();
      this.#bumpOnce();
    }
    return this.read();
  }

  #bumpOnce() {
    const db = this.db;
    db.prepare(
      'UPDATE v2_reconcile_signal SET generation = generation + 1, updated_at = ? WHERE singleton = 1'
    ).run(new Date().toISOString());
  }

  close() {
    if (this.#released) return;
    this.#released = true;
    if (this.#box) {
      releaseStoreConnection(this.#box);
      this.#box = null;
    }
  }
}
