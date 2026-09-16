import { DatabaseSync } from 'node:sqlite';

function encode(value) { return value == null ? null : JSON.stringify(value); }
function decode(value) { return value == null ? null : JSON.parse(value); }
function rowToIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    target: row.target,
    state: row.state,
    recoveryStep: row.recovery_step,
    activeAction: decode(row.active_action_json),
    events: decode(row.events_json) ?? [],
  };
}

export class SQLiteIncidentStore {
  constructor(file) {
    if (!file) throw new Error('SQLiteIncidentStore requires a database file path');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE,
        type TEXT NOT NULL,
        target TEXT NOT NULL,
        state TEXT NOT NULL,
        recovery_step INTEGER NOT NULL,
        active_action_json TEXT,
        events_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_state ON incidents(state);
    `);
  }

  create(type, target) {
    const info = this.db.prepare(`INSERT INTO incidents (id,type,target,state,recovery_step,active_action_json,events_json) VALUES (NULL,?,?,'OPEN',0,NULL,'[]')`).run(type, target);
    const id = `INC-${info.lastInsertRowid}`;
    this.db.prepare('UPDATE incidents SET id=? WHERE seq=?').run(id, info.lastInsertRowid);
    return this.get(id);
  }

  save(incident) {
    this.db.prepare(`UPDATE incidents SET state=?, recovery_step=?, active_action_json=?, events_json=? WHERE id=?`).run(
      incident.state,
      incident.recoveryStep,
      encode(incident.activeAction),
      encode(incident.events ?? []),
      incident.id,
    );
    return this.get(incident.id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown incident ${id}`);
    return rowToIncident(row);
  }

  list() { return this.db.prepare('SELECT * FROM incidents ORDER BY seq').all().map(rowToIncident); }
  close() { this.db.close(); }
}
