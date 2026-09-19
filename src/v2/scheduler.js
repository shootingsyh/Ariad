function topologicalOrder(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const indegree = new Map(tasks.map(task => [task.id, 0]));
  const outgoing = new Map(tasks.map(task => [task.id, []]));
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error(`task ${task.id} depends on unknown task ${dep}`);
      indegree.set(task.id, indegree.get(task.id) + 1);
      outgoing.get(dep).push(task.id);
    }
  }
  const queue = [...tasks.filter(task => indegree.get(task.id) === 0)].sort((a, b) => a.id.localeCompare(b.id));
  const result = [];
  while (queue.length) {
    const task = queue.shift();
    result.push(task);
    for (const nextId of outgoing.get(task.id)) {
      indegree.set(nextId, indegree.get(nextId) - 1);
      if (indegree.get(nextId) === 0) {
        queue.push(byId.get(nextId));
        queue.sort((a, b) => a.id.localeCompare(b.id));
      }
    }
  }
  if (result.length !== tasks.length) throw new Error('task graph contains a cycle');
  return result;
}

function dependenciesDone(task, byId) {
  return (task.dependsOn ?? []).every(id => byId.get(id)?.state === 'DONE');
}

function latestResult(task) {
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.type === 'ROLE_RESULT' && history[i]?.role === task.stage) return history[i];
  }
  return null;
}

export class V2Scheduler {
  constructor({ store, roles, providers, resources }) {
    this.store = store;
    this.roles = roles;
    this.providers = providers;
    this.resources = resources;
  }

  async #advanceResults(projectId) {
    for (const task of this.store.listTasks(projectId)) {
      if (task.state !== 'RESULT_READY') continue;
      const result = latestResult(task);
      if (!result) throw new Error(`task ${task.id} is RESULT_READY without a role result`);
      const role = this.roles.get(task.stage);
      const next = role.transition({ task, result });
      if (!next || !next.state) throw new Error(`role ${task.stage} returned invalid transition`);
      this.store.updateTask(task.id, task.version, {
        ...next,
        execution: null,
      });
    }
  }

  async tick(projectId) {
    await this.#advanceResults(projectId);
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);

    const tasks = this.store.listTasks(projectId);
    const byId = new Map(tasks.map(task => [task.id, task]));
    const ordered = topologicalOrder(tasks);
    const started = [];

    for (const snapshot of ordered) {
      const task = this.store.getTask(snapshot.id);
      if (task.state !== 'READY') continue;
      if (!dependenciesDone(task, byId)) continue;

      const role = this.roles.get(task.stage);
      const spec = role.prepare({ project, task });
      if (!spec?.provider) throw new Error(`role ${task.stage} produced no provider`);
      const requirements = spec.resources ?? [];
      if (!this.resources.claim(requirements, task.id)) continue;

      let claimed;
      try {
        claimed = this.store.updateTask(task.id, task.version, {
          state: 'WORKING',
          execution: {
            provider: spec.provider,
            externalId: null,
            role: task.stage,
            startedAt: new Date().toISOString(),
            resources: structuredClone(requirements),
            sessionPolicy: role.sessionPolicy ?? 'fresh',
          },
        });
      } catch (error) {
        this.resources.release(task.id);
        if (String(error?.message).includes('version conflict')) continue;
        throw error;
      }

      try {
        const provider = this.providers.get(spec.provider);
        const handle = await provider.start({
          ...structuredClone(spec),
          projectId,
          taskId: task.id,
          role: task.stage,
          sessionPolicy: role.sessionPolicy ?? 'fresh',
        });
        const current = this.store.getTask(task.id);
        this.store.updateTask(task.id, current.version, {
          execution: {
            ...current.execution,
            externalId: handle?.externalId ?? handle?.id ?? null,
          },
        });
        started.push(task.id);
      } catch (error) {
        const current = this.store.getTask(task.id);
        this.store.appendTaskHistory(task.id, current.version, {
          type: 'SYSTEM_INTERRUPTION',
          role: task.stage,
          failure: error?.message ?? String(error),
          at: new Date().toISOString(),
        }, {
          state: 'READY',
          execution: null,
        });
        this.resources.release(task.id);
      }
    }

    return { started };
  }
}

export { topologicalOrder };
