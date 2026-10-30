// Read-only compiler for the unified Task Tree. Does not invoke applyDeliveryPlan,
// replan, or change the live project state.
import {buildUnifiedTaskTree,validateUnifiedTaskTree} from './unified-task-tree.js';
import {buildExecutionGraph} from './execution-graph.js';
import {developerTaskPolicyFailure} from './developer-task-policy.js';

export function compileUnifiedTaskTree(artifactRoot) {
  const preview=buildUnifiedTaskTree(artifactRoot);
  const validation=validateUnifiedTaskTree(preview);
  if(!validation.ok) throw new Error('UNIFIED_TASK_TREE_INVALID: '+JSON.stringify(validation.issues));
  const tasks=preview.tasks.map(task=>({
    ...structuredClone(task),
    unifiedTaskSchemaVersion:1,
    input:{intent:task.intent,acceptanceCriteria:[...(task.acceptanceCriteria??[])],
      interfaceIds:[...(task.interfaceIds??[])],milestoneId:task.milestoneId,
      taskKind:task.taskKind??null,ownerMilestoneId:task.ownerMilestoneId??null,
      executionMode:task.executionMode},
  }));
  const graph=buildExecutionGraph(tasks);
  for(const task of tasks){
    const failure=developerTaskPolicyFailure({...task,stage:'developer'});
    if(failure) throw new Error(`UNIFIED_TASK_DEVELOPER_POLICY: ${task.id}: ${failure}`);
  }
  return {schema:'ariad/unified-task-tree',version:1,tasks,
    executionOrder:graph.order,stats:preview.stats};
}

// Read-only compatibility check before connecting the compiler to a migrated
// project. A compiler must not silently add/remove IDs or alter dependencies.
export function verifyUnifiedCompilerAgainstStore({artifactRoot,store,projectId}) {
  const compiled=compileUnifiedTaskTree(artifactRoot);
  const existing=store.listTasks(projectId,{scope:'delivery'});
  const byId=new Map(existing.map(t=>[t.id,t]));
  const compiledById=new Map(compiled.tasks.map(t=>[t.id,t]));
  const issues=[];
  for(const task of compiled.tasks){
    const current=byId.get(task.id);
    if(!current){issues.push({code:'MISSING_MIGRATED_TASK',taskId:task.id});continue;}
    if(current.unifiedTaskSchemaVersion!==1) issues.push({code:'WRONG_SCHEMA_VERSION',taskId:task.id});
    if(current.executionMode!==task.executionMode) issues.push({code:'EXECUTION_MODE_DRIFT',taskId:task.id});
    if(current.parentId!==task.parentId) issues.push({code:'PARENT_DRIFT',taskId:task.id});
    if(JSON.stringify(current.dependsOn??[])!==JSON.stringify(task.dependsOn??[])) issues.push({code:'DEPENDENCY_DRIFT',taskId:task.id});
    if(JSON.stringify(current.interfaceIds??[])!==JSON.stringify(task.interfaceIds??[])) issues.push({code:'INTERFACE_DRIFT',taskId:task.id});
  }
  for(const task of existing) if(!compiledById.has(task.id)) issues.push({code:'UNEXPECTED_MIGRATED_TASK',taskId:task.id});
  return {ok:issues.length===0,issues,compiledCount:compiled.tasks.length,storedCount:existing.length};
}

// Runtime loading gate for projects explicitly prepared on an isolated copy.
// It never invokes the legacy planner and never writes the database. The
// human delivery gate (project.deliveryEnabled) belongs to the scheduler's
// dispatch filter; this read-only load instead requires the factual
// precondition it actually depends on: no delivery execution in flight.
// Tick-loop callers (the PM acceptance) treat UNIFIED_TASK_DELIVERY_IN_FLIGHT
// as "retry on a later tick", never as a failure.
export function loadPreparedUnifiedTaskTree({artifactRoot,store,projectId}) {
  const project=store.getProject(projectId);
  if(project?.unifiedTaskCompilerVersion!==1) throw new Error('UNIFIED_TASK_COMPILER_NOT_PREPARED');
  const inFlight=store.listTasks(projectId,{scope:'delivery'}).filter(task=>task.state==='WORKING');
  if(inFlight.length){
    const error=new Error(`UNIFIED_TASK_DELIVERY_IN_FLIGHT: ${inFlight.map(task=>task.id).join(',')}`);
    error.code='UNIFIED_TASK_DELIVERY_IN_FLIGHT';
    throw error;
  }
  const compatibility=verifyUnifiedCompilerAgainstStore({artifactRoot,store,projectId});
  if(!compatibility.ok) throw new Error('UNIFIED_TASK_COMPILER_STORE_DRIFT: '+JSON.stringify(compatibility.issues));
  const compiled=compileUnifiedTaskTree(artifactRoot);
  const stored=store.listTasks(projectId,{scope:'delivery'});
  return {schema:compiled.schema,version:compiled.version,tasks:stored,
    executionOrder:compiled.executionOrder,stats:compiled.stats,
    historicalExceptions:project.unifiedTaskHistoricalExceptions??[]};
}

// Incremental landing for an approved unified plan. PM acceptance reconciles
// the compiled artifact tree into the store in place: new tasks are created,
// unfinished tasks take the approved spec, dropped unfinished tasks are
// obsoleted, and accepted or in-flight work is never rewritten. Mirrors the
// conservatism of the legacy task-tree reconciler. All writes are atomic.
// The gate signature is exactly the field set verifyUnifiedCompilerAgainstStore
// checks: structure, not prose. Stored DONE aggregates were written at
// migration time from an earlier spec text, so their title/intent/acceptance
// prose legitimately differs from today's artifact text; demanding prose
// equality would false-block every later PM acceptance (batch-55: V2.1/V2.3
// aggregates differ only in prose, yet were reported as REVISE_COMPLETED_TASK).
// Prose refreshes are applied to unfinished tasks only; DONE/blocked work is
// never rewritten either way, so tolerating prose drift there costs nothing.
const unifiedGateSignature = task => JSON.stringify([
  task.parentId ?? null, task.executionMode ?? null,
  task.dependsOn ?? [], task.interfaceIds ?? [],
]);
const unifiedSpecSignature = task => JSON.stringify([
  unifiedGateSignature(task),
  task.title ?? null, task.intent ?? null,
  task.acceptanceCriteria ?? task.input?.acceptanceCriteria ?? [],
  task.testStrategy ?? null,
]);

export function reconcileUnifiedTaskTree({artifactRoot,store,projectId}) {
  const project=store.getProject(projectId);
  if(!project) throw new Error('UNIFIED_TASK_UNKNOWN_PROJECT');
  if(project.unifiedTaskCompilerVersion!==1) throw new Error('UNIFIED_TASK_COMPILER_NOT_PREPARED');
  const existing=store.listTasks(projectId,{scope:'delivery'});
  const wrongSchema=existing.filter(t=>t.unifiedTaskSchemaVersion!==1);
  if(wrongSchema.length){
    const issues=wrongSchema.map(t=>({id:t.id,reason:'WRONG_SCHEMA_VERSION'}));
    const error=new Error('UNIFIED_TASK_TREE_RECONCILE_REQUIRES_REVIEW: '+JSON.stringify(issues));
    error.issues=issues;
    throw error;
  }
  const compiled=compileUnifiedTaskTree(artifactRoot).tasks;
  const wanted=new Map(compiled.map(t=>[t.id,t]));
  const current=new Map(existing.map(t=>[t.id,t]));
  const issues=[]; const inFlightChanged=[];
  const creates=[], updates=[], obsoletes=[];
  for(const spec of compiled){
    const task=current.get(spec.id);
    if(!task){creates.push(spec);continue;}
    if(unifiedSpecSignature(task)===unifiedSpecSignature(spec)) continue;
    // Structural drift (the gate fields) is a genuine revision of accepted
    // work; prose-only drift is tolerated and never rewrites DONE/blocked
    // tasks, and never touches in-flight ones.
    if(unifiedGateSignature(task)!==unifiedGateSignature(spec)){
      if(task.state==='DONE') issues.push({id:task.id,reason:'REVISE_COMPLETED_TASK'});
      else if(task.state==='WORKING'||task.state==='RESULT_READY'||task.execution) inFlightChanged.push(task.id);
      else if(task.state==='NEEDS_HUMAN'||task.state==='SYSTEM_BLOCKED') issues.push({id:task.id,reason:'REVISE_BLOCKED_TASK'});
      else updates.push(spec);
    } else if(['READY','WAITING_REPLAN'].includes(task.state)) {
      updates.push(spec);
    }
  }
  for(const task of existing){
    if(wanted.has(task.id)||task.state==='OBSOLETE'||task.state==='SKIPPED') continue;
    if(task.state==='DONE') issues.push({id:task.id,reason:'REMOVE_COMPLETED_TASK'});
    else if(task.state==='READY'||task.state==='WAITING_REPLAN') obsoletes.push(task);
    else if(task.state==='WORKING'||task.state==='RESULT_READY'||task.execution) inFlightChanged.push(task.id);
    else issues.push({id:task.id,reason:'REMOVE_UNFINISHED_TASK'});
  }
  if(inFlightChanged.length){
    const error=new Error(`UNIFIED_TASK_DELIVERY_IN_FLIGHT: ${[...new Set(inFlightChanged)].join(',')}`);
    error.code='UNIFIED_TASK_DELIVERY_IN_FLIGHT';
    throw error;
  }
  if(issues.length){
    const error=new Error('UNIFIED_TASK_TREE_RECONCILE_REQUIRES_REVIEW: '+JSON.stringify(issues));
    error.issues=issues;
    throw error;
  }
  const updatedIds=new Set(updates.map(t=>t.id));
  const obsoleteIds=new Set(obsoletes.map(t=>t.id));
  const resulting=[
    ...existing.filter(t=>!obsoleteIds.has(t.id)).map(t=>updatedIds.has(t.id)?{...t,...wanted.get(t.id)}:t),
    ...creates,
  ];
  buildExecutionGraph(resulting);
  const now=new Date().toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if(store.getProject(projectId).version!==project.version) throw new Error('UNIFIED_TASK_PROJECT_VERSION_CONFLICT');
    for(const task of obsoletes){
      store.updateTask(task.id,task.version,{
        state:'OBSOLETE',execution:null,
        history:[...(task.history??[]),{type:'TASK_TREE_OBSOLETE',at:now}],
      });
    }
    for(const spec of creates){
      store.createTask({...spec,projectId,state:'READY',stage:spec.stage??'developer'});
    }
    for(const spec of updates){
      const task=current.get(spec.id);
      store.updateTask(task.id,task.version,{
        parentId:spec.parentId,executionMode:spec.executionMode,
        title:spec.title,intent:spec.intent,
        acceptanceCriteria:spec.acceptanceCriteria,testStrategy:spec.testStrategy,
        dependsOn:spec.dependsOn,interfaceIds:spec.interfaceIds,logicalRefs:spec.logicalRefs,
        input:{...(task.input??{}),...(spec.input??{})},
        history:[...(task.history??[]),{type:'UNIFIED_TASK_TREE_RECONCILED',at:now,previousState:task.state}],
      });
    }
    store.db.exec('COMMIT');
  } catch(err){ store.db.exec('ROLLBACK'); throw err; }
  return {created:creates.map(t=>t.id),updated:updates.map(t=>t.id),
    obsoleted:obsoletes.map(t=>t.id),total:compiled.length};
}
