import { DatabaseSync } from 'node:sqlite';

function encode(value) { return value == null ? null : JSON.stringify(value); }
function decode(value) { return value == null ? null : JSON.parse(value); }
function rowToEvent(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq),
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: decode(row.payload_json) ?? {},
    at: row.at,
  };
}

export class SQLiteEventJournal {
  constructor(file) {
    if (!file) throw new Error('SQLiteEventJournal requires a database file path');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_type, aggregate_id, seq);
    `);
  }

  append({ type, aggregateType, aggregateId, payload = {}, at = null }) {
    if (!type || !aggregateType || !aggregateId) throw new Error('event type and aggregate identity are required');
    const timestamp = at ?? new Date().toISOString();
    const info = this.db.prepare(`
      INSERT INTO events (type, aggregate_type, aggregate_id, payload_json, at)
      VALUES (?, ?, ?, ?, ?)
    `).run(type, aggregateType, aggregateId, encode(payload), timestamp);
    return rowToEvent(this.db.prepare('SELECT * FROM events WHERE seq = ?').get(info.lastInsertRowid));
  }

  list({ aggregateType = null, aggregateId = null, afterSeq = 0, limit = 1000 } = {}) {
    let sql = 'SELECT * FROM events WHERE seq > ?';
    const args = [afterSeq];
    if (aggregateType != null) { sql += ' AND aggregate_type = ?'; args.push(aggregateType); }
    if (aggregateId != null) { sql += ' AND aggregate_id = ?'; args.push(aggregateId); }
    sql += ' ORDER BY seq LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args).map(rowToEvent);
  }

  close() { this.db.close(); }
}
