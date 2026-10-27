import {buildExecutionGraph} from './execution-graph.js';
import {buildApprovedTreeSpecs} from './approved-task-tree.js';

const signature = task => JSON.stringify([
  task.parentId ?? null, task.executionMode, task.intent, task.title,
  task.acceptanceCriteria, task.testStrategy, task.dependsOn ?? [],
  task.logicalRefs ?? [], task.interfaceIds ?? [],
]);

// Conservative initial reconciliation: refuse active jobs and changes to
// accepted work. All writes happen atomically and retain task IDs/history.
export function reconcileApprovedTaskTree(store, projectId, plan, {artifactRoot=null}={}) {
  const project=store.getProject(projectId);
  if (!project) throw new Error('TASK_TREE_UNKNOWN_PROJECT');
  const existing=store.listTasks(projectId,{scope:'delivery'});
  if (!existing.length || existing.some(t=>t.taskTreeSchemaVersion!==1)) {
    throw new Error('TASK_TREE_MIGRATION_REQUIRED');
  }
  if (existing.some(t=>['WORKING','RESULT_READY'].includes(t.state) || t.execution)) {
    throw new Error('TASK_TREE_ACTIVE_EXECUTION: pause and drain current roles before reconciliation');
  }
  const next=buildApprovedTreeSpecs(projectId,plan,artifactRoot);
  const wanted=new Map(next.map(t=>[t.id,t]));
  const current=new Map(existing.map(t=>[t.id,t]));
  const issues=[];
  for(const task of existing) {
    const spec=wanted.get(task.id);
    if(!spec && task.state==='DONE') issues.push({id:task.id,reason:'REMOVE_COMPLETED_TASK'});
    if(!spec && !['READY','OBSOLETE','SKIPPED'].includes(task.state)) issues.push({id:task.id,reason:'REMOVE_UNFINISHED_TASK'});
    if(spec && task.state==='DONE' && signature(task)!==signature(spec)) issues.push({id:task.id,reason:'REVISE_COMPLETED_TASK'});
  }
  if(issues.length) {
    const error=new Error('TASK_TREE_REPLAN_REQUIRES_REVIEW: '+JSON.stringify(issues));
    error.issues=issues;
    throw error;
  }
  const same=next.map(spec=>{
    const old=current.get(spec.id);
    if(old?.state==='DONE') return old;
    if(old && signature(old)===signature(spec) && old.state!=='OBSOLETE' && old.state!=='WAITING_REPLAN') return old;
    return spec;
  });
  buildExecutionGraph(same);
  const now=new Date().toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if(store.getProject(projectId).version!==project.version) throw new Error('TASK_TREE_PROJECT_VERSION_CONFLICT');
    for(const task of existing) {
      if(wanted.has(task.id)||['OBSOLETE','SKIPPED'].includes(task.state)) continue;
      store.updateTask(task.id,task.version,{
        state:'OBSOLETE',execution:null,
        history:[...(task.history??[]),{type:'TASK_TREE_OBSOLETE',at:now}],
      });
    }
    for(const spec of next) {
      const task=current.get(spec.id);
      if(!task){store.createTask(spec);continue;}
      if(task.state==='DONE'||(signature(task)===signature(spec)&&task.state!=='OBSOLETE'&&task.state!=='WAITING_REPLAN')) continue;
      store.updateTask(task.id,task.version,{
        ...spec,stage:spec.stage,state:'READY',execution:null,
        input:{...(task.input??{}),...spec.input},
        history:[...(task.history??[]),{type:'TASK_TREE_REPLANNED',at:now,previousState:task.state}],
      });
    }
    store.updateProject(projectId,project.version,{
      taskTreeVersion:(project.taskTreeVersion??1)+1,
      taskTreeRootId:plan.milestones.find(m=>m.parentId==null)?.id??null,
      milestones:structuredClone(plan.milestones),
      logicalNodes:structuredClone(plan.logicalNodes??[]),
    });
    store.db.exec('COMMIT');
  }catch(err){store.db.exec('ROLLBACK');throw err;}
  return {count:next.length,created:next.filter(t=>!current.has(t.id)).length,
    preserved:next.filter(t=>current.get(t.id)?.state==='DONE').length};
}
