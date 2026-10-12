// Read-only state-aware migration preflight. Never mutates the live project.
import { buildUnifiedTaskTree, validateUnifiedTaskTree } from './unified-task-tree.js';

export function preflightUnifiedTaskMigration({ artifactRoot, liveTasks }) {
  const preview = buildUnifiedTaskTree(artifactRoot);
  const validation = validateUnifiedTaskTree(preview);
  const delivery = liveTasks.filter(t => t.scope === 'delivery');
  const liveById = new Map(delivery.map(t => [t.id,t]));
  const oldToNew = new Map(preview.tasks.filter(t => t.legacyIntegrationTaskId)
    .map(t => [t.legacyIntegrationTaskId,t.id]));
  const target = new Set(preview.tasks.map(t=>t.id));
  const extra = delivery.filter(t=>!target.has(t.id)&&!oldToNew.has(t.id));
  const missing = preview.tasks.filter(t=>!liveById.has(t.id)&&!liveById.has(t.legacyIntegrationTaskId));
  const active = liveTasks.filter(t=>['WORKING','RESULT_READY'].includes(t.state));
  const migrations = preview.tasks.map(task => {
    const sourceId = task.legacyIntegrationTaskId ?? task.id;
    const source = liveById.get(sourceId);
    return { id: task.id, sourceId, state: source?.state ?? 'MISSING', historyEntries: source?.history?.length ?? 0,
      version: source?.version ?? null, executionMode: task.executionMode,
      dependsOn: task.dependsOn, interfaceIds: task.interfaceIds ?? [] };
  });
  const blockers = [
    ...(!validation.ok ? ['UNIFIED_GRAPH_INVALID'] : []),
    ...(active.length ? ['ACTIVE_TASKS'] : []),
    ...(extra.length ? ['UNMAPPED_LIVE_TASKS'] : []),
    ...(missing.length ? ['MISSING_TASKS'] : []),
    'SCHEDULER_AGGREGATE_GATE_NOT_WIRED',
    'LIVE_INTERFACE_BINDINGS_NOT_MIGRATED',
  ];
  return { safeToApply: blockers.length === 0, blockers, stats: preview.stats,
    live: { total: delivery.length, states: Object.fromEntries([...new Set(delivery.map(t=>t.state))].map(s=>[s,delivery.filter(t=>t.state===s).length])),
      preservedHistoryEntries: migrations.reduce((n,t)=>n+t.historyEntries,0) },
    idMap: Object.fromEntries(oldToNew),
    extra: extra.map(t=>({id:t.id,state:t.state,historyEntries:t.history?.length??0})),
    missing: missing.map(t=>t.id), migrations, validation };
}

// Apply to an explicitly supplied COPY of state.db, never the live path.
// Keep old task records in an archive table so history/evidence can be audited.
export function applyUnifiedTaskMigrationToCopy({ artifactRoot, store, projectId, isolatedCopyConfirmed = false }) {
  if (!isolatedCopyConfirmed) throw new Error('refusing migration: isolated database copy not explicitly confirmed');
  const liveTasks = store.listTasks(projectId);
  const report = preflightUnifiedTaskMigration({artifactRoot,liveTasks});
  const fatal = report.blockers.filter(x => !['UNMAPPED_LIVE_TASKS','SCHEDULER_AGGREGATE_GATE_NOT_WIRED','LIVE_INTERFACE_BINDINGS_NOT_MIGRATED'].includes(x));
  if (fatal.length) throw new Error(`migration blocked: ${fatal.join(', ')}`);
  if (report.extra.some(t => t.state !== 'OBSOLETE')) throw new Error('cannot archive non-obsolete extra task');
  const preview = buildUnifiedTaskTree(artifactRoot);
  const sourceById = new Map(liveTasks.map(t=>[t.id,t]));
  const now = new Date().toISOString();
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS v2_unified_task_migration_archive (
      original_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, original_data_json TEXT NOT NULL,
      original_version INTEGER NOT NULL, original_updated_at TEXT NOT NULL, archived_at TEXT NOT NULL
    )`);
    const archive = db.prepare(`INSERT INTO v2_unified_task_migration_archive
      (original_id,project_id,original_data_json,original_version,original_updated_at,archived_at)
      VALUES (?,?,?,?,?,?)`);
    const get = db.prepare('SELECT * FROM v2_tasks WHERE id=? AND project_id=?');
    const remove = db.prepare('DELETE FROM v2_tasks WHERE id=? AND project_id=?');
    const insert = db.prepare('INSERT INTO v2_tasks(id,project_id,data_json,version,updated_at) VALUES (?,?,?,?,?)');
    for (const task of liveTasks.filter(t=>t.scope==='delivery')) {
      const row=get.get(task.id,projectId);
      archive.run(row.id,row.project_id,row.data_json,row.version,row.updated_at,now);
      remove.run(task.id,projectId);
    }
    const aliases = report.idMap;
    for (const task of preview.tasks) {
      const source=sourceById.get(task.legacyIntegrationTaskId ?? task.id);
      if (!source) throw new Error(`missing source ${task.id}`);
      const data={...structuredClone(source)};
      for(const key of ['id','projectId','version','updatedAt']) delete data[key];
      data.parentId=task.parentId;
      data.executionMode=task.executionMode;
      // Preserve the original stage/state/execution and all role history.
      data.dependsOn=[...task.dependsOn];
      data.legacyTaskId=task.legacyIntegrationTaskId ?? null;
      data.unifiedTaskSchemaVersion=1;
      data.input={...data.input,executionMode:task.executionMode,interfaceIds:[...(data.input?.interfaceIds ?? [])]};
      // Aggregate tasks retain their normal developer/tester/reviewer lifecycle.
      // Child completion is only a prerequisite, never an automatic verdict.
      if(task.executionMode==='aggregate' && data.state==='DONE' && !(data.history??[]).some(h=>h.type==='ROLE_RESULT')) {
        throw new Error(`aggregate ${task.id} has DONE without recorded role result`);
      }
      insert.run(task.id,projectId,JSON.stringify(data),source.version,source.updatedAt);
    }
    const remaining=store.listTasks(projectId,{scope:'delivery'});
    const oldIds=new Set(Object.keys(aliases));
    if(remaining.length!==preview.tasks.length || remaining.some(t=>oldIds.has(t.id))) throw new Error('postmigration count/ID mismatch');
    for(const task of remaining) for(const dep of task.dependsOn) if(!remaining.some(t=>t.id===dep)) throw new Error(`dangling dependency ${task.id}->${dep}`);
    db.exec('COMMIT');
    return {applied:true,projectId,archiveCount:liveTasks.filter(t=>t.scope==='delivery').length,
      resultingTasks:remaining.length,idMap:aliases,interfaceFixRequired:true,schedulerSwitchRequired:true};
  } catch(e) {db.exec('ROLLBACK');throw e;}
}
