import { DatabaseSync } from 'node:sqlite';

const DURABLE_TABLES = [
  'v2_projects',
  'v2_tasks',
  'v2_planning_requests',
  'v2_system_incidents',
];

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
    this.#installMutationTriggers();
  }

  #installMutationTriggers() {
    const tableExists = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    );
    for (const table of DURABLE_TABLES) {
      if (!tableExists.get(table)) continue;
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const trigger = `ariad_reconcile_${table}_${operation.toLowerCase()}`;
        this.db.exec(`
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
