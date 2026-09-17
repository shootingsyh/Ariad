function assertTask(task) {
  if (!task || typeof task !== 'object') throw new Error('task must be an object');
  if (typeof task.id !== 'string' || !task.id) throw new Error('task.id is required');
  if (task.dependsOn != null && !Array.isArray(task.dependsOn)) throw new Error(`task ${task.id} dependsOn must be an array`);
}

export class TaskGraph {
  constructor(tasks = []) {
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('TaskGraph requires at least one task');
    this.tasks = new Map();
    for (const task of tasks) {
      assertTask(task);
      if (this.tasks.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
      this.tasks.set(task.id, { ...structuredClone(task), dependsOn: [...(task.dependsOn ?? [])] });
    }
    for (const task of this.tasks.values()) {
      for (const dep of task.dependsOn) {
        if (!this.tasks.has(dep)) throw new Error(`task ${task.id} depends on unknown task ${dep}`);
        if (dep === task.id) throw new Error(`task ${task.id} cannot depend on itself`);
      }
    }
    this.#assertAcyclic();
  }

  #assertAcyclic() {
    const visiting = new Set();
    const visited = new Set();
    const visit = id => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`task graph contains a cycle at ${id}`);
      visiting.add(id);
      for (const dep of this.tasks.get(id).dependsOn) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.tasks.keys()) visit(id);
  }

  get(id) {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  list() {
    return [...this.tasks.values()].map(task => structuredClone(task));
  }

  dependenciesSatisfied(taskId, getState) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task.dependsOn.every(dep => getState(dep)?.status === 'SUCCEEDED');
  }
}
