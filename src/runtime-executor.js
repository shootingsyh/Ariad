const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'LOST', 'CANCELLED']);

export class RuntimeExecutor {
  constructor({ registry, runStore, roleRuntimeMap = {}, maxPolls = 100 }) {
    if (!registry || typeof registry.get !== 'function') throw new Error('RuntimeExecutor requires a runtime registry');
    if (!runStore || typeof runStore.create !== 'function') throw new Error('RuntimeExecutor requires a run store');
    this.registry = registry;
    this.runStore = runStore;
    this.roleRuntimeMap = { ...roleRuntimeMap };
    this.maxPolls = maxPolls;
  }

  async #dispatch(run, role, context) {
    const adapter = this.registry.get(run.runtimeKey);
    this.runStore.update(run.id, { state: 'DISPATCHING' });
    const handle = await adapter.start({
      runId: run.id,
      role,
      task: { id: run.taskId },
      context,
    });
    this.runStore.update(run.id, {
      state: handle.state || 'RUNNING',
      externalId: handle.externalId,
      runtimeId: handle.runtimeId || adapter.id,
    });
    return { adapter, handle };
  }

  async #pollToTerminal(run, adapter, handle) {
    let polls = 0;
    while (polls < this.maxPolls) {
      polls += 1;
      const result = await adapter.poll(handle);
      if (!result || typeof result.state !== 'string') throw new Error(`runtime ${adapter.id} returned invalid poll result`);
      if (!TERMINAL_STATES.has(result.state)) {
        this.runStore.update(run.id, { state: result.state });
        continue;
      }
      this.runStore.update(run.id, {
        state: result.state,
        result: Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : null,
        failure: result.failure || null,
      });
      if (result.state === 'COMPLETED') {
        return { executionStatus: 'COMPLETED', outcome: result.outcome, result: result.result ?? null, runId: run.id };
      }
      return { executionStatus: 'FAILED', failure: result.failure || result.state, runState: result.state, runId: run.id };
    }
    this.runStore.update(run.id, { state: 'FAILED', failure: 'POLL_LIMIT_EXCEEDED' });
    return { executionStatus: 'FAILED', failure: 'POLL_LIMIT_EXCEEDED', runId: run.id };
  }

  async redispatch(runId) {
    const run = this.runStore.get(runId);
    if (TERMINAL_STATES.has(run.state)) throw new Error(`cannot redispatch terminal run ${runId}`);
    try {
      const { adapter, handle } = await this.#dispatch(run, run.role, run.context || {});
      return await this.#pollToTerminal(run, adapter, handle);
    } catch (error) {
      this.runStore.update(run.id, { state: 'FAILED', failure: error?.message || String(error) });
      return { executionStatus: 'FAILED', failure: error?.message || String(error), runId: run.id };
    }
  }

  async run(role, context = {}) {
    const runtimeKey = this.roleRuntimeMap[role];
    if (!runtimeKey) throw new Error(`no runtime configured for role ${role}`);
    const adapter = this.registry.get(runtimeKey);
    const taskId = context.taskId || context.featureId || 'unknown-task';
    const run = this.runStore.create({ taskId, role, runtimeKey, runtimeId: adapter.id, context });
    try {
      const { handle } = await this.#dispatch(run, role, context);
      return await this.#pollToTerminal(run, adapter, handle);
    } catch (error) {
      this.runStore.update(run.id, { state: 'FAILED', failure: error?.message || String(error) });
      return { executionStatus: 'FAILED', failure: error?.message || String(error), runId: run.id };
    }
  }
}
