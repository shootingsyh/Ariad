import { DatabaseSync } from 'node:sqlite';

function rowToState(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    stage: row.stage,
    devCycle: row.dev_cycle,
    strategyEpoch: row.strategy_epoch,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export class SQLiteWorkflowStateStore {
  constructor(file) {
    if (!file) throw new Error('SQLiteWorkflowStateStore requires a database file path');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_state (
        task_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        dev_cycle INTEGER NOT NULL,
        strategy_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  create(taskId, initial = {}) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflow_state (task_id, stage, dev_cycle, strategy_epoch, status, version, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      taskId,
      initial.stage ?? 'developer',
      initial.devCycle ?? 1,
      initial.strategyEpoch ?? 1,
      initial.status ?? 'RUNNING',
      now,
    );
    return this.get(taskId);
  }

  get(taskId) {
    const row = this.db.prepare('SELECT * FROM workflow_state WHERE task_id = ?').get(taskId);
    return rowToState(row);
  }

  update(taskId, expectedVersion, patch = {}) {
    const current = this.get(taskId);
    if (!current) throw new Error(`unknown workflow state: ${taskId}`);
    if (current.version !== expectedVersion) throw new Error(`workflow state version conflict: ${taskId}`);
    const next = { ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() };
    const info = this.db.prepare(`
      UPDATE workflow_state SET stage = ?, dev_cycle = ?, strategy_epoch = ?, status = ?, version = ?, updated_at = ?
      WHERE task_id = ? AND version = ?
    `).run(next.stage, next.devCycle, next.strategyEpoch, next.status, next.version, next.updatedAt, taskId, expectedVersion);
    if (info.changes !== 1) throw new Error(`workflow state version conflict: ${taskId}`);
    return this.get(taskId);
  }

  close() {
    this.db.close();
  }
}
