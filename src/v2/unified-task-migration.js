// Read-only state-aware migration preflight. Never mutates the live project.
import { buildUnifiedTaskTree, validateUnifiedTaskTree } from './unified-task-tree.js';
import { buildExecutionGraph } from './execution-graph.js';
import { developerTaskPolicyFailure } from './developer-task-policy.js';
import { realpathSync, statSync } from 'node:fs';

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
export function applyUnifiedTaskMigrationToCopy({ artifactRoot, store, projectId, isolatedCopyConfirmed = false, liveDatabasePath = null }) {
  if (!isolatedCopyConfirmed) throw new Error('refusing migration: isolated database copy not explicitly confirmed');
  const openedPath = store?.db?.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!liveDatabasePath || !openedPath) throw new Error('migration requires a live database path and an identifiable copy path');
  const openedRealPath = realpathSync(openedPath);
  const liveRealPath = realpathSync(liveDatabasePath);
  const openedStat = statSync(openedRealPath);
  const liveStat = statSync(liveRealPath);
  if (openedRealPath === liveRealPath ||
      (openedStat.dev === liveStat.dev && openedStat.ino === liveStat.ino)) {
    throw new Error('refusing migration of live database');
  }
  const liveTasks = store.listTasks(projectId);
  const report = preflightUnifiedTaskMigration({artifactRoot,liveTasks});
  const fatal = report.blockers.filter(x => x !== 'UNMAPPED_LIVE_TASKS');
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
      data.milestoneId=task.milestoneId;
      data.taskKind=task.taskKind ?? data.taskKind;
      data.ownerMilestoneId=task.ownerMilestoneId ?? data.ownerMilestoneId;
      data.executionMode=task.executionMode;
      // Preserve the original stage/state/execution and all role history.
      data.dependsOn=[...task.dependsOn];
      data.legacyTaskId=task.legacyIntegrationTaskId ?? null;
      data.unifiedTaskSchemaVersion=1;
      data.interfaceIds=[...(task.interfaceIds ?? [])];
      data.input={...data.input,interfaceIds:[...(task.interfaceIds ?? [])],milestoneId:task.milestoneId,ownerMilestoneId:data.ownerMilestoneId};
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
    const aggregateValidation=validateMigratedAggregateStates(remaining);
    const runtimeValidation=validateMigratedTaskRuntime(remaining);
    if(!runtimeValidation.ok) throw new Error('migration runtime validation failed: '+JSON.stringify(runtimeValidation.issues));
    // Activate the unified compiler only in this migrated COPY. Delivery stays
    // locked until separate offline review/activation; never alter the live DB.
    const project=store.getProject(projectId);
    store.updateProject(projectId,project.version,{
      unifiedTaskCompilerVersion:1,
      deliveryEnabled:false,
      unifiedTaskMigrationCompletedAt:now,
      unifiedTaskMigrationArchiveCount:liveTasks.filter(t=>t.scope==='delivery').length,
    });
    db.exec('COMMIT');
    return {aggregateValidation,runtimeValidation,applied:true,projectId,archiveCount:liveTasks.filter(t=>t.scope==='delivery').length,
      resultingTasks:remaining.length,idMap:aliases,interfaceFixRequired:true,schedulerSwitchRequired:true};
  } catch(e) {db.exec('ROLLBACK');throw e;}
}

// Structural state consistency: a completed aggregate with unfinished current
// prerequisites needs explicit review; never silently downgrade DONE or rerun.
export function validateMigratedAggregateStates(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const issues = [];
  for (const task of tasks.filter(t => t.executionMode === 'aggregate' && t.state === 'DONE')) {
    for (const depId of task.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (!dep || !['DONE', 'SKIPPED'].includes(dep.state)) {
        issues.push({ code: 'DONE_AGGREGATE_UNFINISHED_PREREQUISITE', taskId: task.id,
          prerequisiteId: depId, prerequisiteState: dep?.state ?? 'MISSING' });
      }
    }
  }
  return {ok: issues.length === 0, issues};
}


// Validate runtime scheduling invariants against the migrated delivery graph.
// This does not dispatch any role or mutate task state.
export function validateMigratedTaskRuntime(tasks) {
  const issues=[];
  let graph;
  try { graph=buildExecutionGraph(tasks); }
  catch(error) { return {ok:false,issues:[{code:'EXECUTION_GRAPH_INVALID',message:String(error.message)}]}; }
  for(const task of tasks) {
    if(!['aggregate','implementation','verification'].includes(task.executionMode)) {
      issues.push({code:'INVALID_EXECUTION_MODE',taskId:task.id});
    }
    if(task.stage==='developer') {
      const error=developerTaskPolicyFailure(task,{requireMilestone:true});
      if(error) issues.push({code:'DEVELOPER_POLICY_FAILURE',taskId:task.id,reason:error});
    }
    if(JSON.stringify(task.interfaceIds??[])!==JSON.stringify(task.input?.interfaceIds??[])) {
      issues.push({code:'INTERFACE_BINDING_MISMATCH',taskId:task.id});
    }
    if(task.executionMode==='aggregate' && task.state==='READY') {
      const unfinished=(task.dependsOn??[]).filter(id=>!['DONE','SKIPPED'].includes(graph.byId.get(id)?.state));
      if(unfinished.length && graph.isRunnable(task)) issues.push({code:'AGGREGATE_PREMATURELY_RUNNABLE',taskId:task.id});
    }
  }
  return {ok:issues.length===0,issues};
}

// Explain historical aggregate conflicts without changing any task state.
// A previous reviewer PASS is evidence of historical acceptance, not proof
// that newly compiled prerequisites have completed.
export function auditAggregateHistoryConflicts(tasks) {
  const byId=new Map(tasks.map(t=>[t.id,t]));
  const conflicts=validateMigratedAggregateStates(tasks).issues;
  return conflicts.map(issue=>{
    const aggregate=byId.get(issue.taskId);
    const prerequisite=byId.get(issue.prerequisiteId);
    const history=aggregate?.history??[];
    const reviewerPass=history.some(h=>h.type==='ROLE_RESULT'&&h.role==='reviewer'&&h.outcome==='PASS');
    const triage=(prerequisite?.history??[]).filter(h=>h.type==='TAKEOVER_NOTE').map(h=>h.summary??'');
    const declaredNonblocking=triage.some(s=>s.includes('VALID_NONBLOCKING_INTEGRATION_REGRESSION'));
    return {...issue,reviewerPass,declaredNonblocking,
      disposition:'REVIEW_REQUIRED',
      explanation:reviewerPass&&declaredNonblocking
        ? 'Historical reviewer acceptance and nonblocking regression triage coexist with an unfinished compiled dependency; preserve both until explicit reconciliation.'
        : 'Unfinished compiled prerequisite requires explicit historical acceptance review.'};
  });
}
