import { DatabaseSync } from 'node:sqlite';

function encode(value) { return value == null ? null : JSON.stringify(value); }
function decode(value) { return value == null ? null : JSON.parse(value); }

function rowToCheckpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    safeToResume: Boolean(row.safe_to_resume),
    payload: decode(row.payload_json) ?? {},
    createdAt: row.created_at,
  };
}

export class SQLiteCheckpointStore {
  constructor(file) {
    if (!file) throw new Error('SQLiteCheckpointStore requires a database file path');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        safe_to_resume INTEGER NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_run_sequence ON checkpoints(run_id, sequence DESC);
    `);
  }

  write({ runId, sequence, safeToResume = false, payload = {} }) {
    if (!runId) throw new Error('checkpoint runId is required');
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error('checkpoint sequence must be a non-negative integer');
    const createdAt = new Date().toISOString();
    const info = this.db.prepare(`
      INSERT INTO checkpoints (run_id, sequence, safe_to_resume, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence, safeToResume ? 1 : 0, encode(payload), createdAt);
    return rowToCheckpoint(this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(info.lastInsertRowid));
  }

  latest(runId) {
    return rowToCheckpoint(this.db.prepare(
      'SELECT * FROM checkpoints WHERE run_id = ? ORDER BY sequence DESC LIMIT 1'
    ).get(runId));
  }

  latestSafe(runId) {
    return rowToCheckpoint(this.db.prepare(
      'SELECT * FROM checkpoints WHERE run_id = ? AND safe_to_resume = 1 ORDER BY sequence DESC LIMIT 1'
    ).get(runId));
  }

  list(runId) {
    return this.db.prepare('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY sequence').all(runId).map(rowToCheckpoint);
  }

  close() { this.db.close(); }
}
