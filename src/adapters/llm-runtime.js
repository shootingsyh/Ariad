export class LLMRuntimeAdapter {
  constructor({ id = 'llm-runtime', roleExecutor }) {
    if (!roleExecutor || typeof roleExecutor.run !== 'function') throw new Error('LLMRuntimeAdapter requires roleExecutor');
    this.id = id;
    this.config = {};
    this.roleExecutor = roleExecutor;
    this.runs = new Map();
    this.installed = false;
  }

  async install() {
    const changed = !this.installed;
    this.installed = true;
    return { state: 'INSTALLED', changed };
  }

  async probe() {
    return { health: 'HEALTHY' };
  }

  async start(request) {
    const runId = request?.runId;
    if (!runId) throw new Error('runId is required');
    if (!this.runs.has(runId)) {
      const record = { state: 'RUNNING', cancelled: false, result: null, error: null };
      record.promise = Promise.resolve()
        .then(() => this.roleExecutor.run(request.role, request.context ?? {}))
        .then((value) => { record.result = value; record.state = 'COMPLETED'; })
        .catch((error) => { record.error = error; record.state = 'FAILED'; });
      this.runs.set(runId, record);
    }
    return { runtimeId: this.id, runId, externalId: runId, state: 'RUNNING' };
  }

  async resume(request) {
    return this.start(request);
  }

  async poll(handle) {
    const record = this.runs.get(handle?.runId);
    if (!record) return { state: 'LOST', failure: 'UNKNOWN_RUN' };
    await record.promise;
    if (record.cancelled) return { state: 'CANCELLED', failure: 'CANCELLED' };
    if (record.state === 'FAILED') return { state: 'FAILED', failure: record.error?.message || String(record.error) };
    if (record.state !== 'COMPLETED') return { state: record.state };
    return {
      state: 'COMPLETED',
      outcome: record.result?.outcome,
      result: record.result,
    };
  }

  async cancel(handle) {
    const record = this.runs.get(handle?.runId);
    if (!record) return { state: 'LOST' };
    record.cancelled = true;
    record.state = 'CANCELLED';
    return { state: 'CANCELLED' };
  }
}
