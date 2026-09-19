export class FunctionProvider {
  constructor({ id = 'ariad-code' } = {}) {
    this.id = id;
    this.results = new Map();
  }

  async start(spec) {
    if (typeof spec?.execute !== 'function') throw new Error(`${this.id} requires execute()`);
    const externalId = spec.idempotencyKey ?? `${spec.projectId}:${spec.taskId}`;
    try {
      const result = await spec.execute();
      this.results.set(externalId, {
        state: 'COMPLETED',
        outcome: result?.outcome ?? 'PASS',
        result: result?.result ?? result ?? null,
        summary: result?.summary ?? '',
        keyPoints: result?.keyPoints ?? [],
        artifacts: result?.artifacts ?? [],
      });
    } catch (error) {
      this.results.set(externalId, {
        state: 'FAILED',
        failure: error?.message ?? String(error),
      });
    }
    return { externalId };
  }

  async poll(handle) {
    return this.results.get(handle.externalId) ?? { state: 'LOST', failure: 'CODE_RESULT_NOT_FOUND' };
  }

  async cancel(handle) {
    this.results.delete(handle.externalId);
    return { state: 'CANCELLED' };
  }
}
