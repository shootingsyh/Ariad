const TERMINAL = new Set(['SUCCEEDED', 'NEEDS_HUMAN', 'WAITING_REPLAN']);

export class GraphRunner {
  constructor({ graph, workBuilder, coordinator, stateStore, maxTicks = 100 }) {
    if (!graph || typeof graph.list !== 'function') throw new Error('GraphRunner requires task graph');
    if (!workBuilder || typeof workBuilder.buildReady !== 'function') throw new Error('GraphRunner requires work builder');
    if (!coordinator || typeof coordinator.tick !== 'function') throw new Error('GraphRunner requires coordinator');
    if (!stateStore || typeof stateStore.get !== 'function') throw new Error('GraphRunner requires workflow state store');
    this.graph = graph;
    this.workBuilder = workBuilder;
    this.coordinator = coordinator;
    this.stateStore = stateStore;
    this.maxTicks = maxTicks;
  }

  snapshot() {
    return Object.fromEntries(this.graph.list().map(task => [task.id, this.stateStore.get(task.id)]));
  }

  isComplete() {
    return this.graph.list().every(task => this.stateStore.get(task.id)?.status === 'SUCCEEDED');
  }

  hasTerminalFailure() {
    return this.graph.list().some(task => {
      const status = this.stateStore.get(task.id)?.status;
      return status && TERMINAL.has(status) && status !== 'SUCCEEDED';
    });
  }

  async run() {
    const history = [];
    for (let tick = 1; tick <= this.maxTicks; tick++) {
      if (this.isComplete()) return { status: 'SUCCEEDED', ticks: tick - 1, history, states: this.snapshot() };
      if (this.hasTerminalFailure()) return { status: 'STOPPED', ticks: tick - 1, history, states: this.snapshot() };

      const ready = this.workBuilder.buildReady();
      if (ready.length === 0) {
        return { status: 'STALLED', ticks: tick - 1, history, states: this.snapshot() };
      }
      const outcomes = await this.coordinator.tick(ready);
      history.push({ tick, ready: structuredClone(ready), outcomes: structuredClone(outcomes) });
    }
    return { status: 'MAX_TICKS', ticks: this.maxTicks, history, states: this.snapshot() };
  }
}
