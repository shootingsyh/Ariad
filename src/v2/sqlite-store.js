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
      CREATE TABLE IF NOT EXISTS v2_planning_requests (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL,
        batch_id TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_v2_planning_project_state
        ON v2_planning_requests(project_id, state, sequence);
      CREATE TABLE IF NOT EXISTS v2_system_incidents (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        task_id TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_v2_incidents_project
        ON v2_system_incidents(project_id, sequence);
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

  applyDeliveryPlan(projectId, plan) {
    if (!this.getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
    const deliverySpecs = plan?.tasks;
    if (!Array.isArray(deliverySpecs) || deliverySpecs.length === 0) {
      throw new Error('delivery plan requires tasks');
    }
    if (plan?.version !== 3 && !plan?.rootTaskId) {
      throw new Error('legacy delivery plan requires rootTaskId');
    }

    const incoming = new Map(deliverySpecs.map(task => [task.id, task]));
    if (incoming.size !== deliverySpecs.length) throw new Error('delivery plan contains duplicate task ids');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.listTasks(projectId, { scope: 'delivery' });
      for (const task of current) {
        if (incoming.has(task.id)) continue;
        if (task.state === 'DONE') {
          // Completed work is immutable historical truth across project versions.
          // A later milestone plan may stop referencing it, but must not rewrite
          // prior completion as OBSOLETE.
          continue;
        }
        if (task.state === 'WORKING') {
          throw new Error(`cannot obsolete WORKING delivery task: ${task.id}`);
        }
        this.updateTask(task.id, task.version, {
          state: 'OBSOLETE',
          execution: null,
        });
      }

      for (const spec of deliverySpecs) {
        const existing = this.getTask(spec.id);
        const patch = {
          parentId: spec.parentId ?? null,
          dependsOn: [...(spec.dependsOn ?? [])],
          logicalRefs: [...(spec.logicalRefs ?? [])],
          title: spec.title,
          intent: spec.intent,
          acceptanceCriteria: [...(spec.acceptanceCriteria ?? [])],
          testStrategy: spec.testStrategy,
          verification: structuredClone(spec.verification ?? []),
          art: spec.art == null ? null : structuredClone(spec.art),
          revisionMode: spec.revisionMode ?? 'implementation',
          milestoneId: spec.milestoneId ?? null,
          input: {
            ...(existing?.input ?? {}),
            intent: spec.intent,
            acceptanceCriteria: [...(spec.acceptanceCriteria ?? [])],
            testStrategy: spec.testStrategy,
            verification: structuredClone(spec.verification ?? []),
            art: spec.art == null ? null : structuredClone(spec.art),
            revisionMode: spec.revisionMode ?? 'implementation',
            milestoneId: spec.milestoneId ?? null,
            logicalRefs: [...(spec.logicalRefs ?? [])],
          },
        };

        if (!existing) {
          this.#insertTask({
            id: spec.id,
            projectId,
            scope: 'delivery',
            stage: spec.revisionMode === 'regression'
              ? 'tester'
              : (spec.art?.required ? 'artist' : 'developer'),
            state: 'READY',
            history: structuredClone(spec.history ?? []),
            artifacts: [],
            execution: null,
            ...patch,
          });
          continue;
        }

        if (existing.projectId !== projectId || existing.scope !== 'delivery') {
          throw new Error(`delivery plan task id collides outside project delivery graph: ${spec.id}`);
        }

        const existingHistory = existing.history ?? [];
        const incomingHistory = spec.history ?? [];
        const serializedExisting = new Set(existingHistory.map(entry => JSON.stringify(entry)));
        const appendedHistory = incomingHistory.filter(entry => !serializedExisting.has(JSON.stringify(entry)));
        const resetForPlan = ['OBSOLETE', 'WAITING_REPLAN'].includes(existing.state);
        const newlyRequiresArt = existing.state === 'READY'
          && existing.stage === 'developer'
          && spec.art?.required
          && !existing.art?.required;
        const plannedStartStage = spec.revisionMode === 'regression'
          ? 'tester'
          : (spec.art?.required ? 'artist' : 'developer');
        this.updateTask(existing.id, existing.version, {
          ...patch,
          history: [...existingHistory, ...structuredClone(appendedHistory)],
          // Preserve execution progress for stable task ids across replans.
          // Re-activated iteration tasks follow the derived revision mode.
          stage: (resetForPlan || newlyRequiresArt) ? plannedStartStage : existing.stage,
          state: resetForPlan ? 'READY' : existing.state,
        });
      }

      const project = this.getProject(projectId);
      this.updateProject(projectId, project.version, {
        deliveryPlanVersion: (project.deliveryPlanVersion ?? 0) + 1,
        deliveryRootTaskId: plan.rootTaskId ?? null,
        deliveryPlanSummary: plan.projectSummary ?? '',
        logicalRootId: plan.logicalRootId ?? null,
        logicalNodes: structuredClone(plan.logicalNodes ?? []),
        milestones: structuredClone(plan.milestones ?? []),
      });

      this.db.exec('COMMIT');
      return this.listTasks(projectId, { scope: 'delivery' });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueuePlanningRequest({ id, projectId, request, context = null }) {
    if (!id) throw new Error('planning request id is required');
    if (!projectId) throw new Error('planning request projectId is required');
    if (request == null || (typeof request === 'string' && request.trim() === '')) {
      throw new Error('planning request content is required');
    }
    if (!this.getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO v2_planning_requests
       (id, project_id, state, batch_id, data_json, created_at, updated_at)
       VALUES (?, ?, 'PENDING', NULL, ?, ?, ?)`
    ).run(id, projectId, encode({ request: structuredClone(request), context: structuredClone(context) }), now, now);
    return this.getPlanningRequest(id);
  }

  getPlanningRequest(id) {
    const row = this.db.prepare(
      'SELECT * FROM v2_planning_requests WHERE id = ?'
    ).get(id);
    if (!row) return null;
    return {
      ...decode(row.data_json),
      id: row.id,
      projectId: row.project_id,
      sequence: row.sequence,
      state: row.state,
      batchId: row.batch_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listPlanningRequests(projectId, { states = null } = {}) {
    const rows = this.db.prepare(
      'SELECT * FROM v2_planning_requests WHERE project_id = ? ORDER BY sequence'
    ).all(projectId);
    return rows.map(row => ({
      ...decode(row.data_json),
      id: row.id,
      projectId: row.project_id,
      sequence: row.sequence,
      state: row.state,
      batchId: row.batch_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })).filter(item => !states || states.includes(item.state));
  }

  hasUnplannedPlanningRequests(projectId) {
    const row = this.db.prepare(
      "SELECT 1 AS found FROM v2_planning_requests WHERE project_id = ? AND state != 'PLANNED' LIMIT 1"
    ).get(projectId);
    return Boolean(row);
  }

  listClaimedPlanningBatches(projectId) {
    return this.db.prepare(
      "SELECT DISTINCT batch_id FROM v2_planning_requests WHERE project_id = ? AND state = 'CLAIMED' AND batch_id IS NOT NULL ORDER BY batch_id"
    ).all(projectId).map(row => row.batch_id);
  }

  createPlanningBatch({ projectId, batchId, requestIds, tasks }) {
    if (!projectId || !batchId) throw new Error('projectId and batchId are required');
    if (!Array.isArray(requestIds) || requestIds.length === 0) throw new Error('planning batch requires requests');
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('planning batch requires flow tasks');
    const flowId = `planner:${projectId}:${batchId}`;
    const ids = new Set(tasks.map(task => task.id));
    if (ids.size !== tasks.length || ids.has(undefined)) throw new Error('planner flow task ids must be present and unique');
    for (const task of tasks) {
      for (const dep of task.dependsOn ?? []) {
        if (!ids.has(dep)) throw new Error(`planner task ${task.id} depends outside flow ${flowId}: ${dep}`);
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const placeholders = requestIds.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT id, state FROM v2_planning_requests
         WHERE project_id = ? AND id IN (${placeholders})`
      ).all(projectId, ...requestIds);
      if (rows.length !== requestIds.length || rows.some(row => row.state !== 'PENDING')) {
        throw new Error('planning batch requests must all be PENDING');
      }
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE v2_planning_requests
         SET state = 'CLAIMED', batch_id = ?, updated_at = ?
         WHERE project_id = ? AND id IN (${placeholders}) AND state = 'PENDING'`
      ).run(batchId, now, projectId, ...requestIds);

      const created = tasks.map(task => this.#insertTask({
        ...task,
        projectId,
        scope: 'control',
        flowId,
      }));
      this.db.exec('COMMIT');
      return { batchId, flowId, tasks: created };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completePlanningBatch(projectId, batchId) {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE v2_planning_requests
       SET state = 'PLANNED', updated_at = ?
       WHERE project_id = ? AND batch_id = ? AND state = 'CLAIMED'`
    ).run(now, projectId, batchId);
    return this.listPlanningRequests(projectId).filter(item => item.batchId === batchId);
  }

  recordIncident(incident) {
    if (!incident?.projectId) throw new Error('incident.projectId is required');
    const at = incident.at ?? new Date().toISOString();
    this.db.prepare(
      'INSERT INTO v2_system_incidents (project_id, task_id, data_json, created_at) VALUES (?, ?, ?, ?)'
    ).run(incident.projectId, incident.taskId ?? null, encode({ ...structuredClone(incident), at }), at);
    return { ...structuredClone(incident), at };
  }

  listIncidents(projectId) {
    return this.db.prepare(
      'SELECT * FROM v2_system_incidents WHERE project_id = ? ORDER BY sequence'
    ).all(projectId).map(row => ({
      sequence: row.sequence,
      ...decode(row.data_json),
      createdAt: row.created_at,
    }));
  }

  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close() {
    this.checkpoint();
    this.db.close();
  }
}

export { graphKey };
