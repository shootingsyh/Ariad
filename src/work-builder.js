const NON_RUNNABLE = new Set(['SUCCEEDED', 'NEEDS_HUMAN', 'WAITING_REPLAN', 'PAUSED_SYSTEM']);

export class WorkBuilder {
  constructor({ graph, stateStore, roleRuntimeMap = {}, resourceResolver = () => [] }) {
    if (!graph || typeof graph.list !== 'function' || typeof graph.dependenciesSatisfied !== 'function') throw new Error('WorkBuilder requires task graph');
    if (!stateStore || typeof stateStore.get !== 'function') throw new Error('WorkBuilder requires workflow state store');
    if (typeof resourceResolver !== 'function') throw new Error('resourceResolver must be a function');
    this.graph = graph;
    this.stateStore = stateStore;
    this.roleRuntimeMap = { ...roleRuntimeMap };
    this.resourceResolver = resourceResolver;
  }

  buildReady() {
    const work = [];
    for (const task of this.graph.list()) {
      const state = this.stateStore.get(task.id);
      if (!state || NON_RUNNABLE.has(state.status) || state.status !== 'RUNNING') continue;
      if (!this.graph.dependenciesSatisfied(task.id, id => this.stateStore.get(id))) continue;
      const runtimeKey = this.roleRuntimeMap[state.stage];
      if (!runtimeKey) throw new Error(`no runtime configured for role ${state.stage}`);
      const resources = this.resourceResolver({ task, state }) ?? [];
      work.push({
        taskId: task.id,
        role: state.stage,
        runtimeKey,
        resources: [...resources],
        context: {
          ...(state.context ?? {}),
          taskId: task.id,
          strategyEpoch: state.strategyEpoch,
          devCycle: state.devCycle,
        },
      });
    }
    return work;
  }
}
