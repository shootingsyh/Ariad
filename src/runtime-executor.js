const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'LOST', 'CANCELLED']);

export class RuntimeExecutor {
  constructor({ registry, runStore, checkpointStore = null, eventJournal = null, roleRuntimeMap = {}, maxPolls = 100 }) {
    if (!registry || typeof registry.get !== 'function') throw new Error('RuntimeExecutor requires a runtime registry');
    if (!runStore || typeof runStore.create !== 'function') throw new Error('RuntimeExecutor requires a run store');
    this.registry = registry;
    this.runStore = runStore;
    this.checkpointStore = checkpointStore;
    this.eventJournal = eventJournal;
    this.roleRuntimeMap = { ...roleRuntimeMap };
    this.maxPolls = maxPolls;
  }

  #event(run, type, payload = {}) {
    if (!this.eventJournal || typeof this.eventJournal.append !== 'function') return;
    this.eventJournal.append({
      type,
      aggregateType: 'run',
      aggregateId: run.id,
      payload: { taskId: run.taskId, role: run.role, runtimeKey: run.runtimeKey, ...payload },
    });
  }

  async #dispatch(run, role, context) {
    const adapter = this.registry.get(run.runtimeKey);
    this.runStore.update(run.id, { state: 'DISPATCHING' });
    this.#event(run, 'RUN_DISPATCHING');
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
    this.#event(run, 'RUN_STARTED', { externalId: handle.externalId, runtimeId: handle.runtimeId || adapter.id });
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
        this.#event(run, 'RUN_COMPLETED', { outcome: result.outcome ?? null });
        return { executionStatus: 'COMPLETED', outcome: result.outcome, result: result.result ?? null, runId: run.id };
      }
      this.#event(run, 'RUN_FAILED', { state: result.state, failure: result.failure || result.state });
      return { executionStatus: 'FAILED', failure: result.failure || result.state, runState: result.state, runId: run.id };
    }
    this.runStore.update(run.id, { state: 'FAILED', failure: 'POLL_LIMIT_EXCEEDED' });
    this.#event(run, 'RUN_FAILED', { state: 'FAILED', failure: 'POLL_LIMIT_EXCEEDED' });
    return { executionStatus: 'FAILED', failure: 'POLL_LIMIT_EXCEEDED', runId: run.id };
  }

  async redispatch(runId) {
    const run = this.runStore.get(runId);
    if (TERMINAL_STATES.has(run.state)) throw new Error(`cannot redispatch terminal run ${runId}`);
    this.#event(run, 'RUN_REDISPATCH_REQUESTED');
    try {
      const { adapter, handle } = await this.#dispatch(run, run.role, run.context || {});
      return await this.#pollToTerminal(run, adapter, handle);
    } catch (error) {
      this.runStore.update(run.id, { state: 'FAILED', failure: error?.message || String(error) });
      this.#event(run, 'RUN_FAILED', { state: 'FAILED', failure: error?.message || String(error) });
      return { executionStatus: 'FAILED', failure: error?.message || String(error), runId: run.id };
    }
  }

  async resume(runId) {
    if (!this.checkpointStore || typeof this.checkpointStore.latestSafe !== 'function') {
      throw new Error('RuntimeExecutor requires checkpointStore to resume');
    }
    const run = this.runStore.get(runId);
    if (run.state === 'COMPLETED' || run.state === 'CANCELLED') throw new Error(`cannot resume terminal run ${runId}`);
    const checkpoint = this.checkpointStore.latestSafe(runId);
    if (!checkpoint) throw new Error(`no safe checkpoint for run ${runId}`);
    const adapter = this.registry.get(run.runtimeKey);
    if (typeof adapter.resume !== 'function') throw new Error(`runtime ${adapter.id} does not support resume`);
    this.#event(run, 'RUN_RESUME_REQUESTED', { checkpointSequence: checkpoint.sequence });
    try {
      this.runStore.update(run.id, { state: 'DISPATCHING', failure: null });
      const handle = await adapter.resume({
        runId: run.id,
        role: run.role,
        task: { id: run.taskId },
        context: run.context || {},
        checkpoint,
      });
      this.runStore.update(run.id, {
        state: handle.state || 'RUNNING',
        externalId: handle.externalId,
        runtimeId: handle.runtimeId || adapter.id,
      });
      this.#event(run, 'RUN_RESUMED', { checkpointSequence: checkpoint.sequence, externalId: handle.externalId });
      return await this.#pollToTerminal(run, adapter, handle);
    } catch (error) {
      this.runStore.update(run.id, { state: 'FAILED', failure: error?.message || String(error) });
      this.#event(run, 'RUN_FAILED', { state: 'FAILED', failure: error?.message || String(error) });
      return { executionStatus: 'FAILED', failure: error?.message || String(error), runId: run.id };
    }
  }

  async run(role, context = {}) {
    const runtimeKey = this.roleRuntimeMap[role];
    if (!runtimeKey) throw new Error(`no runtime configured for role ${role}`);
    const adapter = this.registry.get(runtimeKey);
    const taskId = context.taskId || context.featureId || 'unknown-task';
    const run = this.runStore.create({ taskId, role, runtimeKey, runtimeId: adapter.id, context });
    this.#event(run, 'RUN_CREATED');
    try {
      const { handle } = await this.#dispatch(run, role, context);
      return await this.#pollToTerminal(run, adapter, handle);
    } catch (error) {
      this.runStore.update(run.id, { state: 'FAILED', failure: error?.message || String(error) });
      this.#event(run, 'RUN_FAILED', { state: 'FAILED', failure: error?.message || String(error) });
      return { executionStatus: 'FAILED', failure: error?.message || String(error), runId: run.id };
    }
  }
}
