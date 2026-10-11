// Additive unified Task-tree representation. Legacy milestone artifacts remain read-only.
// Migration is a preview until the scheduler and task compiler adopt this schema.
import { loadPlannerHierarchy, loadBoundaryContracts, buildOwnedExecutionTasks } from './interface-contracts.js';

export function buildUnifiedTaskTree(artifactRoot) {
  const hierarchy = loadPlannerHierarchy(artifactRoot, 'milestone');
  const contracts = loadBoundaryContracts(artifactRoot, 'milestone');
  const legacy = buildOwnedExecutionTasks(artifactRoot);
  const byId = new Map();
  const issues = [];
  const put = task => {
    if (byId.has(task.id)) throw new Error(`unified task ID collision: ${task.id}`);
    byId.set(task.id, task);
  };
  for (const node of hierarchy.items) {
    const contract = contracts.get(node.id);
    const integration = contract?.integrationTasks ?? [];
    const ownIntegration = integration.length === 1 ? integration[0] : null;
    if (integration.length !== 1) issues.push({ code: 'MILESTONE_INTEGRATION_COUNT', milestoneId: node.id, count: integration.length });
    const expected = (node.tasks ?? []).map(task => task.id);
    if (ownIntegration && !expected.includes(ownIntegration.id)) issues.push({ code: 'INTEGRATION_TASK_MISMATCH', milestoneId: node.id, taskId: ownIntegration.id });
    put({
      id: node.id, parentId: node.parentId ?? null,
      title: node.title, intent: node.goal,
      executionMode: 'aggregate',
      dependsOn: [...new Set([...(node.dependsOn ?? []), ...(ownIntegration?.dependsOn ?? [])])],
      logicalRefs: [...(node.logicalRefs ?? [])],
      acceptanceCriteria: [...(node.acceptanceCriteria ?? [])],
      testStrategy: node.testStrategy,
      interfaceIds: (contract?.interfaces ?? []).map(i => i.id),
      interfaceOwner: { graph: 'milestone', nodeId: node.id },
      legacyIntegrationTaskId: ownIntegration?.id ?? null,
      verification: ownIntegration?.verification ?? [],
    });
  }
  const promoted = new Map(hierarchy.items.flatMap(node => {
    const list = contracts.get(node.id)?.integrationTasks ?? [];
    return list.length === 1 ? [[list[0].id, node.id]] : [];
  }));
  const owner = new Map();
  for (const node of hierarchy.items) for (const task of node.tasks ?? []) {
    if (owner.has(task.id) && owner.get(task.id) !== node.id) issues.push({ code: 'MULTIPLE_MILESTONE_OWNERS', taskId: task.id, owners: [owner.get(task.id), node.id] });
    owner.set(task.id, node.id);
  }
  for (const task of legacy) {
    if (promoted.has(task.id)) continue;
    const parentId = owner.get(task.id) ?? task.milestoneRefs?.[0] ?? null;
    if (!parentId || !byId.has(parentId)) issues.push({ code: 'UNOWNED_TASK', taskId: task.id, parentId });
    put({ ...task, parentId, executionMode: 'implementation',
      dependsOn: [...(task.dependsOn ?? [])].map(id => promoted.get(id) ?? id),
    });
  }
  for (const task of byId.values()) {
    if (task.executionMode === 'aggregate') {
      const directChildren = [...byId.values()].filter(child => child.parentId === task.id).map(child => child.id);
      task.dependsOn = [...new Set([...task.dependsOn, ...directChildren])];
    }
    task.dependsOn = [...new Set(task.dependsOn.map(id => promoted.get(id) ?? id))];
    for (const dep of task.dependsOn) if (!byId.has(dep)) issues.push({ code: 'UNKNOWN_DEPENDENCY', taskId: task.id, dependsOn: dep });
    if (task.parentId && !byId.has(task.parentId)) issues.push({ code: 'UNKNOWN_PARENT', taskId: task.id, parentId: task.parentId });
  }
  return { version: 1, schema: 'ariad/unified-task-tree-preview', tasks: [...byId.values()].sort((a,b)=>a.id.localeCompare(b.id)), issues,
    stats: { milestoneNodes: hierarchy.items.length, legacyCompiledTasks: legacy.length, promotedIntegrationTasks: promoted.size,
      unifiedTasks: byId.size, aggregateTasks: hierarchy.items.length, executableTasks: byId.size-hierarchy.items.length } };
}

export function validateUnifiedTaskTree(preview) {
  const tasks = preview.tasks;
  const byId = new Map(tasks.map(t => [t.id,t]));
  if (byId.size !== tasks.length) throw new Error('duplicate unified task IDs');
  for (const task of tasks) {
    if (!['aggregate','implementation','verification'].includes(task.executionMode)) throw new Error(`invalid execution mode ${task.id}`);
    if (task.parentId && !byId.has(task.parentId)) throw new Error(`unknown parent ${task.id}`);
    for (const dep of task.dependsOn) if (!byId.has(dep)) throw new Error(`unknown dependency ${task.id}: ${dep}`);
  }
  for (const edge of ['parentId','dependsOn']) {
    const visiting = new Set(), visited = new Set();
    function visit(id) {
      if (visiting.has(id)) throw new Error(`${edge} cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const task = byId.get(id);
      for (const next of edge === 'parentId' ? (task.parentId ? [task.parentId] : []) : task.dependsOn) visit(next);
      visiting.delete(id); visited.add(id);
    }
    for (const task of tasks) visit(task.id);
  }
  return { ok: preview.issues.length === 0, issues: preview.issues };
}
