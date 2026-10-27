import { buildExecutionGraph } from './execution-graph.js';
import { developerTaskPolicyFailure } from './developer-task-policy.js';

// Persist the approved planner's task/milestone nodes directly; no second
// delivery-plan graph or synthetic integration task is generated.
export function acceptInitialTaskTree(store, projectId, plan) {
  if (plan?.version !== 3 || !Array.isArray(plan.milestones) || !Array.isArray(plan.tasks)) {
    throw new Error('APPROVED_TASK_TREE_REQUIRES_VALIDATED_V3_PLAN');
  }
  if (!store.getProject(projectId)) throw new Error('UNKNOWN_PROJECT');
  if (store.listTasks(projectId, { scope: 'delivery' }).length) {
    throw new Error('APPROVED_TASK_TREE_EXISTING_TASKS: revisions require tree-aware reconciliation');
  }
  const milestones = plan.milestones;
  const tasks = plan.tasks;
  const ids = new Set([...milestones.map(x => x.id), ...tasks.map(x => x.id)]);
  if (ids.size !== milestones.length + tasks.length) throw new Error('APPROVED_TASK_TREE_DUPLICATE_ID');
  const children = new Map(milestones.map(m => [m.id, []]));
  for (const m of milestones) if (m.parentId) {
    if (!children.has(m.parentId)) throw new Error('APPROVED_TASK_TREE_UNKNOWN_PARENT');
    children.get(m.parentId).push(m.id);
  }
  for (const t of tasks) {
    if (!children.has(t.milestoneId)) throw new Error('APPROVED_TASK_TREE_UNKNOWN_OWNER');
    children.get(t.milestoneId).push(t.id);
  }
  const specs = [
    ...milestones.map(m => ({
      id:m.id, projectId, scope:'delivery', taskKind:'MILESTONE_TASK',
      executionMode:'aggregate', stage:'developer', state:'READY',
      parentId:m.parentId, milestoneId:m.id, title:m.title, intent:m.goal,
      acceptanceCriteria:[...m.acceptanceCriteria], testStrategy:m.testStrategy,
      logicalRefs:[...m.logicalRefs], verification:[],
      dependsOn:[...new Set([...children.get(m.id), ...m.dependsOn])],
      input:{intent:m.goal, milestoneId:m.id, acceptanceCriteria:[...m.acceptanceCriteria], executionMode:'aggregate'},
    })),
    ...tasks.map(t => ({
      ...structuredClone(t), projectId, scope:'delivery',
      taskKind:'MILESTONE_TASK', executionMode:'implementation', stage:t.revisionMode==='regression'?'tester':t.art?.required?'artist':'developer',
      state:'READY', parentId:t.milestoneId,
      input:{intent:t.intent, acceptanceCriteria:[...t.acceptanceCriteria], milestoneId:t.milestoneId,
        testStrategy:t.testStrategy, interfaceIds:[...(t.interfaceIds??[])], executionMode:'implementation'},
    })),
  ];
  for (const s of specs) {
    const failure = developerTaskPolicyFailure(s);
    if (failure) throw new Error(failure + ': ' + s.id);
  }
  buildExecutionGraph(specs); // Validate one graph before any writes.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (store.listTasks(projectId, {scope:'delivery'}).length) throw new Error('APPROVED_TASK_TREE_RACE');
    for (const spec of specs) store.createTask(spec);
    const project = store.getProject(projectId);
    store.updateProject(projectId, project.version, {
      taskTreeVersion:(project.taskTreeVersion??0)+1,
      taskTreeRootId: milestones.find(m=>m.parentId==null)?.id??null,
      logicalNodes:structuredClone(plan.logicalNodes??[]),
      milestones:structuredClone(milestones),
    });
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return specs.length;
}
