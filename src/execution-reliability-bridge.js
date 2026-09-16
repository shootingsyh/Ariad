export class ExecutionReliabilityBridge {
  constructor({ reliability }) {
    if (!reliability || typeof reliability.detect !== 'function') {
      throw new Error('ExecutionReliabilityBridge requires reliability service');
    }
    this.reliability = reliability;
  }

  observe({ taskId, runId, runtimeKey, execution }) {
    if (!execution || execution.executionStatus !== 'FAILED') return null;
    const target = runId || taskId || runtimeKey || 'unknown-execution';
    const incident = this.reliability.detect('EXECUTION_FAILURE', target);
    return {
      ...incident,
      observation: {
        taskId: taskId ?? null,
        runId: runId ?? null,
        runtimeKey: runtimeKey ?? null,
        failure: execution.failure ?? null,
        runState: execution.runState ?? null,
      },
    };
  }
}
