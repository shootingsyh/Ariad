export class RunReconciler {
  constructor({ store, registry, emit = () => {} }) {
    if (!store || typeof store.listRecoverable !== 'function') throw new Error('RunReconciler requires a run store with listRecoverable()');
    if (!registry || typeof registry.get !== 'function') throw new Error('RunReconciler requires a runtime registry');
    this.store = store;
    this.registry = registry;
    this.emit = emit;
  }

  async reconcile() {
    const observations = [];
    for (const run of this.store.listRecoverable()) {
      if ((run.state === 'CREATED' || run.state === 'DISPATCHING') && !run.externalId) {
        const event = {
          type: 'RUN_READY_TO_REDISPATCH',
          runId: run.id,
          runtimeKey: run.runtimeKey,
          previousState: run.state,
        };
        observations.push(event);
        this.emit(event);
        continue;
      }

      const adapter = this.registry.get(run.runtimeKey);
      let result;
      try {
        result = await adapter.poll({
          runtimeId: run.runtimeId || adapter.id,
          runId: run.id,
          externalId: run.externalId,
          state: run.state,
        });
      } catch (error) {
        const event = { type: 'RUN_RECONCILE_FAILED', runId: run.id, runtimeKey: run.runtimeKey, error: error?.message || String(error) };
        observations.push(event);
        this.emit(event);
        continue;
      }

      if (result?.state === 'COMPLETED') {
        this.store.update(run.id, { state: 'COMPLETED', result: { outcome: result.outcome ?? null, result: result.result ?? null }, failure: null });
        const event = { type: 'RUN_RECONCILED_COMPLETED', runId: run.id };
        observations.push(event);
        this.emit(event);
        continue;
      }
      if (result?.state === 'LOST') {
        this.store.update(run.id, { state: 'LOST', failure: { kind: 'RUN_LOST', detail: result } });
        const event = { type: 'RUN_LOST', runId: run.id, runtimeKey: run.runtimeKey };
        observations.push(event);
        this.emit(event);
        continue;
      }
      if (result?.state) this.store.update(run.id, { state: result.state });
      const event = { type: 'RUN_RECONCILED_ACTIVE', runId: run.id, runtimeKey: run.runtimeKey, state: result?.state ?? run.state };
      observations.push(event);
      this.emit(event);
    }
    return observations;
  }
}
