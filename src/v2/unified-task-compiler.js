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
    scope:'delivery',
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
// It never invokes the legacy planner and never writes the database.
export function loadPreparedUnifiedTaskTree({artifactRoot,store,projectId}) {
  const project=store.getProject(projectId);
  if(project?.unifiedTaskCompilerVersion!==1) throw new Error('UNIFIED_TASK_COMPILER_NOT_PREPARED');
  if(project.deliveryEnabled!==false) throw new Error('UNIFIED_TASK_DELIVERY_NOT_LOCKED');
  const compatibility=verifyUnifiedCompilerAgainstStore({artifactRoot,store,projectId});
  if(!compatibility.ok) throw new Error('UNIFIED_TASK_COMPILER_STORE_DRIFT: '+JSON.stringify(compatibility.issues));
  const compiled=compileUnifiedTaskTree(artifactRoot);
  const stored=store.listTasks(projectId,{scope:'delivery'});
  return {schema:compiled.schema,version:compiled.version,tasks:stored,
    executionOrder:compiled.executionOrder,stats:compiled.stats,
    historicalExceptions:project.unifiedTaskHistoricalExceptions??[]};
}
