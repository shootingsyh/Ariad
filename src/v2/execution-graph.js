import { graphKey } from './sqlite-store.js';

function addEdge(prerequisites, dependents, from, to) {
  if (from === to) throw new Error(`self dependency: ${from}`);
  prerequisites.get(to).add(from);
  dependents.get(from).add(to);
}

export function buildExecutionGraph(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('duplicate task ids in execution graph');

  const prerequisites = new Map(tasks.map(task => [task.id, new Set()]));
  const dependents = new Map(tasks.map(task => [task.id, new Set()]));

  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (!dep) throw new Error(`task ${task.id} depends on unknown task ${depId}`);
      if (graphKey(dep) !== graphKey(task)) {
        throw new Error(`task ${task.id} depends outside graph ${graphKey(task)}: ${depId}`);
      }
      addEdge(prerequisites, dependents, depId, task.id);
    }

    // parentId, when present on legacy tasks, is logical structure only.
    // Execution ordering comes exclusively from dependsOn. New artifact plans
    // derive milestone hierarchy prerequisites into dependsOn before scheduling.
  }

  const indegree = new Map([...prerequisites].map(([id, deps]) => [id, deps.size]));
  const queue = tasks.filter(task => indegree.get(task.id) === 0).map(task => task.id).sort();
  const order = [];

  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (order.length !== tasks.length) {
    throw new Error(`execution graph contains a cycle in ${tasks[0] ? graphKey(tasks[0]) : 'empty'}`);
  }

  return {
    tasks,
    byId,
    prerequisites,
    dependents,
    order,
    prerequisitesOf(id) {
      return [...(prerequisites.get(id) ?? [])];
    },
    dependentsOf(id) {
      return [...(dependents.get(id) ?? [])];
    },
    isRunnable(task) {
      if (!task || task.state !== 'READY') return false;
      return [...(prerequisites.get(task.id) ?? [])]
        .every(id => ['DONE', 'SKIPPED'].includes(byId.get(id)?.state));
    },
    downstreamImpact(taskId) {
      const seen = new Set();
      const stack = [...(dependents.get(taskId) ?? [])];
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const task = byId.get(id);
        if (task && task.state !== 'DONE' && task.state !== 'OBSOLETE') {
          for (const next of dependents.get(id) ?? []) stack.push(next);
        }
      }
      return [...seen].filter(id => {
        const task = byId.get(id);
        return task && task.state !== 'DONE' && task.state !== 'OBSOLETE';
      }).length;
    },
  };
}

export function partitionExecutionGraphs(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = graphKey(task);
    const items = groups.get(key) ?? [];
    items.push(task);
    groups.set(key, items);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    graph: buildExecutionGraph(items),
  }));
}
