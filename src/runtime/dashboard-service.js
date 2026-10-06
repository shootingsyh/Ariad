import { createServer,             } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dashboardHtml } from './dashboard-page.js';






function decode(value         ) {
  return value == null ? null : JSON.parse(String(value));
}

function json(res     , status        , value         ) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function html(res     , body        ) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function summarizeTasks(tasks       ) {
  const count = (state        ) => tasks.filter(task => task.state === state).length;
  return {
    total: tasks.length,
    ready: count('READY'),
    working: count('WORKING'),
    resultReady: count('RESULT_READY'),
    waitingReplan: count('WAITING_REPLAN'),
    needsHuman: count('NEEDS_HUMAN'),
    systemBlocked: count('SYSTEM_BLOCKED'),
    done: count('DONE'),
    skipped: count('SKIPPED'),
    obsolete: count('OBSOLETE'),
  };
}

function readProjectDb(project     ) {
  if (!project.stateDb || !existsSync(project.stateDb)) {
    return { tasks: [], planning: [], incidents: [], runtimeProject: null };
  }

  const db = new DatabaseSync(project.stateDb, { readOnly: true });
  try {
    const tableRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v2_%'"
    ).all()         ;
    const tables = new Set(tableRows.map(row => row.name));

    const runtimeProject = tables.has('v2_projects')
      ? db.prepare('SELECT id, data_json, version, updated_at FROM v2_projects WHERE id = ?').get(project.id)
      : null;

    const tasks = tables.has('v2_tasks')
      ? (db.prepare('SELECT id, project_id, data_json, version, updated_at FROM v2_tasks WHERE project_id = ? ORDER BY rowid')
          .all(project.id)         )
          .map(row => ({
            ...decode(row.data_json),
            id: row.id,
            projectId: row.project_id,
            version: row.version,
            updatedAt: row.updated_at,
          }))
      : [];

    const planning = tables.has('v2_planning_requests')
      ? (db.prepare(
          'SELECT sequence, id, project_id, state, batch_id, data_json, created_at, updated_at FROM v2_planning_requests WHERE project_id = ? ORDER BY sequence'
        ).all(project.id)         ).map(row => ({
          ...decode(row.data_json),
          sequence: row.sequence,
          id: row.id,
          projectId: row.project_id,
          state: row.state,
          batchId: row.batch_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }))
      : [];

    const incidents = tables.has('v2_system_incidents')
      ? (db.prepare(
          'SELECT sequence, task_id, data_json, created_at FROM v2_system_incidents WHERE project_id = ? ORDER BY sequence DESC LIMIT 100'
        ).all(project.id)         ).map(row => ({
          sequence: row.sequence,
          taskId: row.task_id,
          ...decode(row.data_json),
          createdAt: row.created_at,
        }))
      : [];

    return {
      runtimeProject: runtimeProject
        ? {
            ...decode(runtimeProject.data_json),
            id: runtimeProject.id,
            version: runtimeProject.version,
            updatedAt: runtimeProject.updated_at,
          }
        : null,
      tasks,
      planning,
      incidents,
    };
  } finally {
    db.close();
  }
}

function projectView(manager                , name        ) {
  const project = manager.status(name);
  const db = readProjectDb(project);
  const activeTasks = db.tasks.filter((task     ) =>
    !['DONE', 'SKIPPED', 'OBSOLETE'].includes(task.state)
  );
  return {
    project,
    runtimeProject: db.runtimeProject,
    summary: summarizeTasks(db.tasks),
    planningSummary: {
      pending: db.planning.filter((item     ) => item.state === 'PENDING').length,
      claimed: db.planning.filter((item     ) => item.state === 'CLAIMED').length,
      planned: db.planning.filter((item     ) => item.state === 'PLANNED').length,
    },
    activeTasks,
    tasks: db.tasks,
    planning: db.planning,
    incidents: db.incidents,
  };
}


function activePlannerNodes(project, kind) {
  const dir = join(project.workspace, '.ariad', 'artifacts', 'planner', kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .flatMap(name => {
      try {
        const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        return value && typeof value.id === 'string' ? [value] : [];
      } catch { return []; }
    });
}

function readSnapshot(path        ) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function snapshotPath(project     , version        ) {
  return join(project.workspace, '.ariad', 'versions', `v${version}`, 'snapshot.json');
}

function availableVersions(project     , db                                  ) {
  const versionsRoot = join(project.workspace, '.ariad', 'versions');
  const historical = new Map             ();
  if (existsSync(versionsRoot)) {
    for (const entry of readdirSync(versionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /^v(\d+)$/.exec(entry.name);
      if (!match) continue;
      const version = Number(match[1]);
      const snapshot = readSnapshot(join(versionsRoot, entry.name, 'snapshot.json'));
      if (!snapshot) continue;
      historical.set(version, {
        version,
        current: false,
        capturedAt: snapshot.capturedAt ?? null,
        featureCount: Array.isArray(snapshot.logicalNodes) ? snapshot.logicalNodes.length : 0,
        milestoneCount: Array.isArray(snapshot.milestones) ? snapshot.milestones.length : 0,
        taskCount: Array.isArray(snapshot.deliveryTasks) ? snapshot.deliveryTasks.length : 0,
      });
    }
  }

  const runtime = db.runtimeProject ?? {};
  const activeVersion = Number.isInteger(runtime.activeVersion)
    ? runtime.activeVersion
    : (Number.isInteger(project.activeVersion) ? project.activeVersion : null);
  const completedVersion = Number.isInteger(runtime.projectVersion)
    ? runtime.projectVersion
    : (Number.isInteger(project.projectVersion) ? project.projectVersion : 0);
  const currentVersion = activeVersion && activeVersion > 0
    ? activeVersion
    : (completedVersion > 0 ? completedVersion : 1);

  const activeFeatures = activePlannerNodes(project, 'logical');
  const activeMilestones = activePlannerNodes(project, 'milestones');
  historical.set(currentVersion, {
    version: currentVersion,
    current: true,
    capturedAt: null,
    featureCount: Array.isArray(runtime.logicalNodes) && runtime.logicalNodes.length
      ? runtime.logicalNodes.length : activeFeatures.length,
    milestoneCount: Array.isArray(runtime.milestones) && runtime.milestones.length
      ? runtime.milestones.length : activeMilestones.length,
    taskCount: db.tasks.filter((task     ) => task.scope === 'delivery').length,
  });

  return [...historical.values()].sort((a, b) => a.version - b.version);
}

function projectVersionView(manager                , name        , version        ) {
  const project = manager.status(name);
  const db = readProjectDb(project);
  const versions = availableVersions(project, db);
  const meta = versions.find(item => item.version === version);
  if (!meta) throw new Error(`unknown project version: v${version}`);

  if (meta.current) {
    const runtime = db.runtimeProject ?? {};
    return {
      version,
      current: true,
      sourceLabel: 'Live durable project state',
      capturedAt: null,
      logicalRootId: runtime.logicalRootId ?? null,
      logicalNodes: Array.isArray(runtime.logicalNodes) && runtime.logicalNodes.length
        ? runtime.logicalNodes : activePlannerNodes(project, 'logical'),
      milestones: Array.isArray(runtime.milestones) && runtime.milestones.length
        ? runtime.milestones : activePlannerNodes(project, 'milestones'),
      deliveryPlanVersion: runtime.deliveryPlanVersion ?? null,
      deliveryPlanSummary: runtime.deliveryPlanSummary ?? null,
      deliveryRootTaskId: runtime.deliveryRootTaskId ?? null,
      tasks: db.tasks.filter((task     ) => task.scope === 'delivery'),
    };
  }

  const snapshot = readSnapshot(snapshotPath(project, version));
  if (!snapshot) throw new Error(`snapshot unavailable for project version v${version}`);
  return {
    version,
    current: false,
    sourceLabel: 'Immutable completed-version snapshot',
    capturedAt: snapshot.capturedAt ?? null,
    logicalRootId: snapshot.logicalRootId ?? null,
    logicalNodes: Array.isArray(snapshot.logicalNodes) ? snapshot.logicalNodes : [],
    milestones: Array.isArray(snapshot.milestones) ? snapshot.milestones : [],
    deliveryPlanVersion: snapshot.deliveryPlanVersion ?? null,
    deliveryPlanSummary: snapshot.deliveryPlanSummary ?? null,
    deliveryRootTaskId: snapshot.deliveryRootTaskId ?? null,
    tasks: Array.isArray(snapshot.deliveryTasks) ? snapshot.deliveryTasks : [],
  };
}

export class AriadDashboardService {
                   manager                ;
                   host        ;
                   port        ;
                   logger     ;
          server                = null;

  constructor({
    manager,
    host = '127.0.0.1',
    port = 18791,
    logger,
  }




   ) {
    this.manager = manager;
    this.host = host;
    this.port = port;
    this.logger = logger;
  }

  async start() {
    if (this.server) return;
    this.server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method !== 'GET') {
          json(res, 405, { error: 'read-only dashboard' });
          return;
        }
        if (url.pathname === '/api/projects') {
          const projects = this.manager.list().map(project => {
            const db = readProjectDb(project);
            return {
              project,
              summary: summarizeTasks(db.tasks),
              planningSummary: {
                pending: db.planning.filter((item     ) => item.state === 'PENDING').length,
                claimed: db.planning.filter((item     ) => item.state === 'CLAIMED').length,
                planned: db.planning.filter((item     ) => item.state === 'PLANNED').length,
              },
              incidentCount: db.incidents.length,
            };
          });
          json(res, 200, projects);
          return;
        }
        if (url.pathname.startsWith('/api/projects/')) {
          const parts = url.pathname.slice('/api/projects/'.length).split('/').filter(Boolean);
          const id = decodeURIComponent(parts[0] ?? '');
          if (!id) {
            json(res, 404, { error: 'project id is required' });
            return;
          }
          if (parts.length === 2 && parts[1] === 'versions') {
            const project = this.manager.status(id);
            json(res, 200, availableVersions(project, readProjectDb(project)));
            return;
          }
          if (parts.length === 3 && parts[1] === 'versions') {
            const version = Number(parts[2]);
            if (!Number.isInteger(version) || version < 1) {
              json(res, 400, { error: 'version must be a positive integer' });
              return;
            }
            json(res, 200, projectVersionView(this.manager, id, version));
            return;
          }
          if (parts.length === 1) {
            json(res, 200, projectView(this.manager, id));
            return;
          }
          json(res, 404, { error: 'not found' });
          return;
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
          html(res, dashboardHtml());
          return;
        }
        json(res, 404, { error: 'not found' });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    await new Promise      ((resolve, reject) => {
      const server = this.server ;
      const onError = (error       ) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
    this.logger?.info?.(`Ariad dashboard listening on http://${this.host}:${this.port}`);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise      ((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  get address() {
    const address = this.server?.address();
    return address && typeof address === 'object'
      ? { host: this.host, port: address.port }
      : null;
  }

  get url() {
    const address = this.address;
    return address ? `http://${address.host}:${address.port}` : `http://${this.host}:${this.port}`;
  }
}
