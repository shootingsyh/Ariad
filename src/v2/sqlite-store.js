import { DatabaseSync } from 'node:sqlite';

function encode(value) {
  return JSON.stringify(value ?? null);
}

function decode(value) {
  return value == null ? null : JSON.parse(value);
}

function rowToProject(row) {
  if (!row) return null;
  return { ...decode(row.data_json), id: row.id, version: row.version, updatedAt: row.updated_at };
}

function rowToTask(row) {
  if (!row) return null;
  return {
    ...decode(row.data_json),
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function normalizeTask(task) {
  const scope = task.scope ?? 'delivery';
  if (!['delivery', 'control'].includes(scope)) throw new Error(`invalid task scope: ${scope}`);
  if (scope === 'control' && (!task.flowId || typeof task.flowId !== 'string')) {
    throw new Error('control task requires flowId');
  }
  if (scope === 'delivery' && task.flowId != null) {
    throw new Error('delivery task cannot have flowId');
  }
  return {
    dependsOn: [],
    scope,
    stage: 'developer',
    state: 'READY',
    input: {},
    history: [],
    artifacts: [],
    execution: null,
    ...structuredClone(task),
    scope,
    flowId: scope === 'control' ? task.flowId : undefined,
  };
}

function graphKey(task) {
  return task.scope === 'control' ? `control:${task.flowId}` : 'delivery';
}

export class SQLiteV2Store {
  constructor(file) {
    if (!file) throw new Error('SQLiteV2Store requires a database file path');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS v2_projects (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v2_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_v2_tasks_project ON v2_tasks(project_id);
    `);
  }

  createProject(project) {
    if (!project?.id) throw new Error('project.id is required');
    const now = new Date().toISOString();
    const data = { ...structuredClone(project) };
    delete data.version;
    delete data.updatedAt;
    this.db.prepare(
      'INSERT INTO v2_projects (id, data_json, version, updated_at) VALUES (?, ?, 1, ?)'
    ).run(project.id, encode(data), now);
    return this.getProject(project.id);
  }

  getProject(id) {
    return rowToProject(this.db.prepare('SELECT * FROM v2_projects WHERE id = ?').get(id));
  }

  updateProject(id, expectedVersion, patch) {
    const current = this.getProject(id);
    if (!current) throw new Error(`unknown project: ${id}`);
    if (current.version !== expectedVersion) throw new Error(`project version conflict: ${id}`);
    const next = { ...current, ...structuredClone(patch), id };
    delete next.version;
    delete next.updatedAt;
    const version = expectedVersion + 1;
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'UPDATE v2_projects SET data_json = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?'
    ).run(encode(next), version, now, id, expectedVersion);
    if (result.changes !== 1) throw new Error(`project version conflict: ${id}`);
    return this.getProject(id);
  }

  #insertTask(task) {
    const normalized = normalizeTask(task);
    const now = new Date().toISOString();
    const data = { ...normalized };
    delete data.id;
    delete data.projectId;
    delete data.version;
    delete data.updatedAt;
    this.db.prepare(
      'INSERT INTO v2_tasks (id, project_id, data_json, version, updated_at) VALUES (?, ?, ?, 1, ?)'
    ).run(normalized.id, normalized.projectId, encode(data), now);
    return this.getTask(normalized.id);
  }

  createTask(task) {
    if (!task?.id) throw new Error('task.id is required');
    if (!task?.projectId) throw new Error('task.projectId is required');
    return this.#insertTask(task);
  }

  createControlFlow({ projectId, flowId, tasks }) {
    if (!projectId) throw new Error('projectId is required');
    if (!flowId) throw new Error('flowId is required');
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('control flow requires tasks');

    const ids = new Set(tasks.map(task => task.id));
    if (ids.size !== tasks.length || ids.has(undefined)) throw new Error('control flow task ids must be present and unique');
    for (const task of tasks) {
      for (const dep of task.dependsOn ?? []) {
        if (!ids.has(dep)) throw new Error(`control flow task ${task.id} depends outside flow ${flowId}: ${dep}`);
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const created = tasks.map(task => this.#insertTask({
        ...task,
        projectId,
        scope: 'control',
        flowId,
      }));
      this.db.exec('COMMIT');
      return created;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getTask(id) {
    return rowToTask(this.db.prepare('SELECT * FROM v2_tasks WHERE id = ?').get(id));
  }

  listTasks(projectId, filter = {}) {
    const tasks = this.db.prepare(
      'SELECT * FROM v2_tasks WHERE project_id = ? ORDER BY rowid'
    ).all(projectId).map(rowToTask);
    return tasks.filter(task => {
      if (filter.scope && task.scope !== filter.scope) return false;
      if (filter.flowId && task.flowId !== filter.flowId) return false;
      return true;
    });
  }

  listControlFlows(projectId) {
    const grouped = new Map();
    for (const task of this.listTasks(projectId, { scope: 'control' })) {
      const items = grouped.get(task.flowId) ?? [];
      items.push(task);
      grouped.set(task.flowId, items);
    }
    return [...grouped.entries()].map(([flowId, tasks]) => ({ flowId, tasks }));
  }

  updateTask(id, expectedVersion, patch) {
    const current = this.getTask(id);
    if (!current) throw new Error(`unknown task: ${id}`);
    if (current.version !== expectedVersion) throw new Error(`task version conflict: ${id}`);

    const candidate = normalizeTask({ ...current, ...structuredClone(patch), id, projectId: current.projectId });
    if (graphKey(candidate) !== graphKey(current)) throw new Error('task graph membership is immutable');

    const next = { ...candidate, id, projectId: current.projectId };
    delete next.version;
    delete next.updatedAt;
    const version = expectedVersion + 1;
    const now = new Date().toISOString();
    const data = { ...next };
    delete data.id;
    delete data.projectId;
    const result = this.db.prepare(
      'UPDATE v2_tasks SET data_json = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?'
    ).run(encode(data), version, now, id, expectedVersion);
    if (result.changes !== 1) throw new Error(`task version conflict: ${id}`);
    return this.getTask(id);
  }

  appendTaskHistory(id, expectedVersion, entry, patch = {}) {
    const current = this.getTask(id);
    if (!current) throw new Error(`unknown task: ${id}`);
    if (current.version !== expectedVersion) throw new Error(`task version conflict: ${id}`);
    return this.updateTask(id, expectedVersion, {
      ...patch,
      history: [...(current.history ?? []), structuredClone(entry)],
    });
  }

  close() {
    this.db.close();
  }
}

export { graphKey };
