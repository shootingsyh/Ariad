import { DatabaseSync } from 'node:sqlite';

function rowToLease(row) {
  if (!row) return null;
  return {
    id: row.id,
    resource: row.resource,
    owner: row.owner,
    state: row.state,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
  };
}

export class SQLiteLeaseStore {
  constructor(file, options = {}) {
    if (!file) throw new Error('SQLiteLeaseStore requires a database file path');
    this.now = options.now ?? (() => Date.now());
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resource_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource TEXT NOT NULL,
        owner TEXT NOT NULL,
        state TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_resource_leases_resource_state ON resource_leases(resource, state);
      CREATE INDEX IF NOT EXISTS idx_resource_leases_expiry ON resource_leases(state, expires_at);
    `);
  }

  acquire({ resource, owner, ttlMs, capacity = 1 }) {
    if (!resource || !owner) throw new Error('resource and owner are required');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be positive');
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('capacity must be a positive integer');
    this.reapExpired();
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM resource_leases WHERE resource = ? AND state = 'ACTIVE'"
    ).get(resource);
    if (Number(row.count) >= capacity) return null;
    const now = this.now();
    const info = this.db.prepare(`
      INSERT INTO resource_leases (resource, owner, state, acquired_at, expires_at, released_at)
      VALUES (?, ?, 'ACTIVE', ?, ?, NULL)
    `).run(resource, owner, now, now + ttlMs);
    return rowToLease(this.db.prepare('SELECT * FROM resource_leases WHERE id = ?').get(info.lastInsertRowid));
  }

  renew(id, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be positive');
    const current = this.get(id);
    if (current.state !== 'ACTIVE') return current;
    this.db.prepare('UPDATE resource_leases SET expires_at = ? WHERE id = ?').run(this.now() + ttlMs, id);
    return this.get(id);
  }

  release(id) {
    const current = this.get(id);
    if (current.state === 'RELEASED' || current.state === 'EXPIRED') return current;
    this.db.prepare("UPDATE resource_leases SET state = 'RELEASED', released_at = ? WHERE id = ?")
      .run(this.now(), id);
    return this.get(id);
  }

  reapExpired() {
    const now = this.now();
    const rows = this.db.prepare(
      "SELECT * FROM resource_leases WHERE state = 'ACTIVE' AND expires_at <= ? ORDER BY id"
    ).all(now);
    for (const row of rows) {
      this.db.prepare("UPDATE resource_leases SET state = 'EXPIRED', released_at = ? WHERE id = ?")
        .run(now, row.id);
    }
    return rows.map(row => ({ ...rowToLease(row), state: 'EXPIRED', releasedAt: now }));
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM resource_leases WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown lease: ${id}`);
    return rowToLease(row);
  }

  listActive(resource = null) {
    this.reapExpired();
    const rows = resource
      ? this.db.prepare("SELECT * FROM resource_leases WHERE state = 'ACTIVE' AND resource = ? ORDER BY id").all(resource)
      : this.db.prepare("SELECT * FROM resource_leases WHERE state = 'ACTIVE' ORDER BY id").all();
    return rows.map(rowToLease);
  }

  close() { this.db.close(); }
}
