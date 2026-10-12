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
