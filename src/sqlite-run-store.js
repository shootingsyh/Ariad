import { DatabaseSync } from 'node:sqlite';

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'LOST', 'CANCELLED']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function encode(value) {
  return value == null ? null : JSON.stringify(value);
}

function decode(value) {
  return value == null ? null : JSON.parse(value);
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    runtimeKey: row.runtime_key,
    runtimeId: row.runtime_id,
    attempt: row.attempt,
    state: row.state,
    externalId: row.external_id,
    context: decode(row.context_json) ?? {},
    result: decode(row.result_json),
    failure: decode(row.failure_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SQLiteRunStore {
  constructor(file) {
    if (!file) throw new Error('SQLiteRunStore requires a database file path');
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        runtime_key TEXT NOT NULL,
        runtime_id TEXT,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        external_id TEXT,
        context_json TEXT,
        result_json TEXT,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task_role ON runs(task_id, role);
      CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
    `);
  }

  nextAttempt(taskId, role) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND role = ?'
    ).get(taskId, role);
    return Number(row.count) + 1;
  }

  create({ taskId, role, runtimeKey, runtimeId = null, context = {} }) {
    const attempt = this.nextAttempt(taskId, role);
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO runs (
        id, task_id, role, runtime_key, runtime_id, attempt, state,
        external_id, context_json, result_json, failure_json, created_at, updated_at
      ) VALUES (NULL, ?, ?, ?, ?, ?, 'CREATED', NULL, ?, NULL, NULL, ?, ?)
    `);
    const info = insert.run(taskId, role, runtimeKey, runtimeId, attempt, encode(context), now, now);
    const id = `RUN-${info.lastInsertRowid}`;
    this.db.prepare('UPDATE runs SET id = ? WHERE seq = ?').run(id, info.lastInsertRowid);
    return this.get(id);
  }

  update(id, patch) {
    const current = this.get(id);
    const next = {
      ...current,
      ...clone(patch),
      id: current.id,
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(`
      UPDATE runs SET
        runtime_id = ?,
        state = ?,
        external_id = ?,
        context_json = ?,
        result_json = ?,
        failure_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.runtimeId,
      next.state,
      next.externalId,
      encode(next.context),
      encode(next.result),
      encode(next.failure),
      next.updatedAt,
      id,
    );
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown run: ${id}`);
    return rowToRun(row);
  }

  list() {
    return this.db.prepare('SELECT * FROM runs ORDER BY seq').all().map(rowToRun);
  }

  listRecoverable() {
    return this.list().filter(run => !TERMINAL_STATES.has(run.state));
  }

  close() {
    this.db.close();
  }
}

export { TERMINAL_STATES };
