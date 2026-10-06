import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function tokenize(query) {
  return [...new Set(String(query ?? '').toLowerCase().match(/[a-z0-9_.:/-]{2,}/g) ?? [])].slice(0, 12);
}

function normalizeBinding(binding) {
  const type = String(binding?.type ?? '').trim();
  const id = String(binding?.id ?? '').trim();
  if (!type || !id) throw new Error('memory binding requires type and id');
  return { type, id };
}

export class ProjectMemoryStore {
  constructor(workspace) {
    if (!workspace) throw new Error('ProjectMemoryStore requires workspace');
    this.path = join(workspace, '.ariad', 'memory.db');
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_bindings (
        memory_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        PRIMARY KEY(memory_id, artifact_type, artifact_id),
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_bindings_artifact
        ON memory_bindings(artifact_type, artifact_id, memory_id);
      CREATE INDEX IF NOT EXISTS idx_memories_active_updated
        ON memories(active, updated_at DESC);
    `);
  }

  remember({ text, kind = 'note', bindings = [] } = {}) {
    const statement = String(text ?? '').trim();
    if (!statement) throw new Error('memory text is required');
    const normalizedBindings = bindings.map(normalizeBinding)
      .sort((a, b) => (a.type + ':' + a.id).localeCompare(b.type + ':' + b.id));
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind, text: statement, bindings: normalizedBindings }))
      .digest('hex').slice(0, 24);
    const id = `mem-${fingerprint}`;
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
      if (existing) {
        this.db.prepare('UPDATE memories SET active = 1, updated_at = ? WHERE id = ?').run(now, id);
      } else {
        this.db.prepare(
          'INSERT INTO memories (id, kind, text, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
        ).run(id, String(kind || 'note'), statement, now, now);
      }
      const insertBinding = this.db.prepare(
        'INSERT OR IGNORE INTO memory_bindings (memory_id, artifact_type, artifact_id) VALUES (?, ?, ?)'
      );
      for (const binding of normalizedBindings) insertBinding.run(id, binding.type, binding.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row) return null;
    const bindings = this.db.prepare(
      'SELECT artifact_type AS type, artifact_id AS id FROM memory_bindings WHERE memory_id = ? ORDER BY artifact_type, artifact_id'
    ).all(id);
    return {
      id: row.id,
      kind: row.kind,
      text: row.text,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      bindings,
    };
  }

  search({ query = '', artifactType = null, artifactId = null, kind = null, limit = 10 } = {}) {
    const capped = Math.max(1, Math.min(Number(limit) || 10, 50));
    const params = [];
    let sql = `
      SELECT DISTINCT m.*
      FROM memories m
      LEFT JOIN memory_bindings b ON b.memory_id = m.id
      WHERE m.active = 1
    `;
    if (artifactType) { sql += ' AND b.artifact_type = ?'; params.push(String(artifactType)); }
    if (artifactId) { sql += ' AND b.artifact_id = ?'; params.push(String(artifactId)); }
    if (kind) { sql += ' AND m.kind = ?'; params.push(String(kind)); }
    const tokens = tokenize(query);
    for (const token of tokens) {
      sql += ' AND lower(m.text) LIKE ?';
      params.push(`%${token}%`);
    }
    sql += ' ORDER BY m.updated_at DESC LIMIT ?';
    params.push(capped);
    return this.db.prepare(sql).all(...params).map(row => this.get(row.id));
  }

  archive(id) {
    this.db.prepare('UPDATE memories SET active = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return this.get(id);
  }

  close() {
    this.db.close();
  }
}
