import { graphKey } from './sqlite-store.js';
import { buildExecutionGraph, partitionExecutionGraphs } from './execution-graph.js';
import { createNextPlanningBatch, isPlannerTask } from './planner-flow.js';

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
      const next = await role.transition({ task, result });
      if (!next || !next.state) throw new Error(`role ${task.stage} returned invalid transition`);
      const { skipTaskIds = [], transitionHistory = null, ...patch } = next;
      let updated = this.store.updateTask(task.id, task.version, {
        ...patch,
        execution: null,
      });
      if (transitionHistory) {
        updated = this.store.appendTaskHistory(task.id, updated.version, transitionHistory);
      }
      for (const skipId of skipTaskIds) {
        const skipped = this.store.getTask(skipId);
        if (skipped && skipped.state === 'READY') {
          this.store.updateTask(skipId, skipped.version, { state: 'SKIPPED', execution: null });
        }
      }
      if (typeof role.afterPersist === 'function') {
        const followUp = await role.afterPersist({ task: updated, result });
        if (followUp) {
          const { patch: followUpPatch = {}, transitionHistory: followUpHistory = null } = followUp;
          updated = this.store.updateTask(updated.id, updated.version, followUpPatch);
          if (followUpHistory) {
            updated = this.store.appendTaskHistory(updated.id, updated.version, followUpHistory);
          }
        }
      }
    }
  }

  #settlePlanningBatches(projectId) {
    for (const batchId of this.store.listClaimedPlanningBatches(projectId)) {
      const flowId = `planner:${projectId}:${batchId}`;
      const tasks = this.store.listTasks(projectId, { flowId });
      if (tasks.length > 0 && tasks.every(task => ['DONE', 'SKIPPED'].includes(task.state))) {
        this.store.completePlanningBatch(projectId, batchId);
      }
    }
  }

  async tick(projectId) {
    await this.#advanceResults(projectId);
    this.#settlePlanningBatches(projectId);

    if (this.store.hasUnplannedPlanningRequests(projectId)) {
      createNextPlanningBatch({ store: this.store, projectId });
    }

    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);

    const allTasks = this.store.listTasks(projectId);
    const planningBlocked = this.store.hasUnplannedPlanningRequests(projectId);
    const deliveryEnabled = project.deliveryEnabled !== false;
    const schedulableTasks = planningBlocked
      ? allTasks.filter(isPlannerTask)
      : allTasks.filter(task =>
          !isPlannerTask(task)
          && (task.scope !== 'delivery' || deliveryEnabled)
        );
    const candidates = [];

    for (const { key, graph } of partitionExecutionGraphs(schedulableTasks)) {
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

      const priorAttempts = (task.history ?? []).filter(entry =>
        entry?.type === 'ROLE_RESULT'
        || (entry?.type === 'SYSTEM_INTERRUPTION' && entry?.consumeAttempt !== false)
      ).length;
      const attemptId = `${projectId}:${task.id}:${task.stage}:${priorAttempts + 1}`;
      const idempotencyKey = `ariad:v2:${attemptId}`;

      try {
        this.store.updateTask(task.id, task.version, {
          state: 'WORKING',
          execution: {
            provider: spec.provider,
            externalId: null,
            attemptId,
            idempotencyKey,
            role: task.stage,
            completionProtocol: spec.completionProtocol ?? 'provider_terminal',
            protocolVersion: spec.completionProtocol === 'role_result_tool' ? 'role-result-v2' : 'provider-terminal-v1',
            projectVersion: project.activeVersion ?? project.projectVersion ?? 0,
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
          ...spec,
          projectId,
          taskId: task.id,
          role: task.stage,
          scope: task.scope,
          flowId: task.flowId ?? null,
          sessionPolicy: role.sessionPolicy ?? 'fresh',
          attemptId,
          idempotencyKey,
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
