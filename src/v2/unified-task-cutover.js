// Prepare the unified Task Tree compiler handoff on an isolated SQLite copy.
// Fail closed: this operation never enables delivery or rewrites role history.
import {realpathSync,statSync} from 'node:fs';
import {verifyUnifiedCompilerAgainstStore} from './unified-task-compiler.js';
import {auditAggregateHistoryConflicts,validateMigratedAggregateStates,validateMigratedTaskRuntime} from './unified-task-migration.js';

export function prepareUnifiedTaskCutoverOnCopy({artifactRoot,store,projectId,liveDatabasePath,isolatedCopyConfirmed=false}) {
  if(!isolatedCopyConfirmed) throw new Error('UNIFIED_CUTOVER_REQUIRES_ISOLATED_COPY');
  const opened=store?.db?.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
  if(!opened||!liveDatabasePath) throw new Error('UNIFIED_CUTOVER_REQUIRES_LIVE_DATABASE_PATH');
  const a=realpathSync(opened),b=realpathSync(liveDatabasePath),sa=statSync(a),sb=statSync(b);
  if(a===b||(sa.dev===sb.dev&&sa.ino===sb.ino)) throw new Error('UNIFIED_CUTOVER_REFUSES_LIVE_DATABASE');
  const project=store.getProject(projectId);
  if(!project) throw new Error('UNIFIED_CUTOVER_PROJECT_MISSING');
  if(project.deliveryEnabled!==false) throw new Error('UNIFIED_CUTOVER_DELIVERY_MUST_BE_DISABLED');
  const tasks=store.listTasks(projectId,{scope:'delivery'});
  if(tasks.some(t=>['WORKING','RESULT_READY'].includes(t.state))) throw new Error('UNIFIED_CUTOVER_ACTIVE_TASKS');
  const compatibility=verifyUnifiedCompilerAgainstStore({artifactRoot,store,projectId});
  const runtime=validateMigratedTaskRuntime(tasks);
  const aggregates=validateMigratedAggregateStates(tasks);
  const historyConflicts=auditAggregateHistoryConflicts(tasks);
  // The explicit exception records historical reviewer acceptance, not a
  // completion verdict for unfinished regression tasks. Only evidence-backed
  // nonblocking triage is eligible; all other conflicts remain blocking.
  const unresolved=historyConflicts.filter(c=>!c.reviewerPass||!c.declaredNonblocking);
  const report={compatibility,runtime,aggregates,historyConflicts,unresolved};
  if(!compatibility.ok||!runtime.ok||unresolved.length) return {prepared:false,...report};
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const current=store.getProject(projectId);
    if(current.version!==project.version) throw new Error('UNIFIED_CUTOVER_PROJECT_VERSION_CHANGED');
    store.updateProject(projectId,current.version,{unifiedTaskCompilerVersion:1,deliveryEnabled:false,unifiedTaskHistoricalExceptions:historyConflicts.map(c=>({aggregateId:c.taskId,prerequisiteId:c.prerequisiteId,reason:'HISTORICAL_REVIEWER_PASS_NONBLOCKING_REGRESSION'}))});
    store.db.exec('COMMIT');
  }catch(e){store.db.exec('ROLLBACK');throw e;}
  return {prepared:true,...report};
}
