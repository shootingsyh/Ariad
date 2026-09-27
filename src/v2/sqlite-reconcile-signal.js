import { DatabaseSync } from 'node:sqlite';

export class SQLiteReconcileSignal {
  constructor(file) {
    if (!file) throw new Error('SQLiteReconcileSignal requires a database file path');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS v2_reconcile_signal (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO v2_reconcile_signal (singleton, generation, updated_at)
      VALUES (1, 0, CURRENT_TIMESTAMP);
    `);
  }

  read() {
    return Number(this.db.prepare(
      'SELECT generation FROM v2_reconcile_signal WHERE singleton = 1'
    ).get().generation);
  }

  bump() {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE v2_reconcile_signal SET generation = generation + 1, updated_at = ? WHERE singleton = 1'
    ).run(now);
    return this.read();
  }

  close() {
    this.db.close();
  }
}
