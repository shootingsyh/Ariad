import { graphKey } from './sqlite-store.js';
import { buildExecutionGraph, partitionExecutionGraphs } from './execution-graph.js';

function topologicalOrder(tasks) {
  const graph = buildExecutionGraph(tasks);
  return graph.order.map(id => graph.byId.get(id));
}

function partitionGraphs(tasks) {
  return partitionExecutionGraphs(tasks).map(({ key, graph }) => ({ key, tasks: graph.tasks }));
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

    const allTasks = this.store.listTasks(projectId);
    const candidates = [];

    for (const { key, graph } of partitionExecutionGraphs(allTasks)) {
      for (const task of graph.tasks) {
        if (!graph.isRunnable(task)) continue;
        candidates.push({
          task,
          graphKey: key,
          impact: graph.downstreamImpact(task.id),
        });
      }
    }

    // Prefer work that can unblock the largest unfinished downstream region.
    // Stable deterministic tie-breakers keep scheduling reproducible.
    candidates.sort((a, b) =>
      b.impact - a.impact
      || a.graphKey.localeCompare(b.graphKey)
      || a.task.id.localeCompare(b.task.id)
    );

    const started = [];

    for (const candidate of candidates) {
      const task = this.store.getTask(candidate.task.id);
      if (task.state !== 'READY') continue;

      // Rebuild the task's graph from fresh durable state before claiming it.
      const sameGraphTasks = this.store.listTasks(projectId)
        .filter(item => graphKey(item) === graphKey(task));
      const graph = buildExecutionGraph(sameGraphTasks);
      const fresh = graph.byId.get(task.id);
      if (!graph.isRunnable(fresh)) continue;

      const role = this.roles.get(task.stage);
      const spec = role.prepare({ project, task });
      if (!spec?.provider) throw new Error(`role ${task.stage} produced no provider`);
      const requirements = spec.resources ?? [];
      if (!this.resources.claim(requirements, task.id)) continue;

      try {
        this.store.updateTask(task.id, task.version, {
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
          scope: task.scope,
          flowId: task.flowId ?? null,
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

export { topologicalOrder, partitionGraphs };
