import { ReliabilityService } from './reliability.js';
import { ExecutionReliabilityBridge } from './execution-reliability-bridge.js';

function createDefaultRetryReliability(maxRecoveries) {
  return new ReliabilityService({
    policies: {
      EXECUTION_FAILURE: Array.from({ length: maxRecoveries }, () => 'RETRY_EXECUTION'),
    },
    execute: async action => action === 'RETRY_EXECUTION',
  });
}

export class ReliabilityExecutionExecutor {
  constructor({ executor, reliability = null, bridge = null, maxRecoveries = 2 }) {
    if (!executor || typeof executor.run !== 'function') {
      throw new Error('ReliabilityExecutionExecutor requires an executor');
    }
    if (!Number.isInteger(maxRecoveries) || maxRecoveries < 0) {
      throw new Error('maxRecoveries must be a non-negative integer');
    }
    this.executor = executor;
    this.maxRecoveries = maxRecoveries;
    this.reliability = reliability ?? createDefaultRetryReliability(maxRecoveries);
    this.bridge = bridge ?? new ExecutionReliabilityBridge({ reliability: this.reliability });
  }

  async run(role, context = {}, options = {}) {
    let recoveries = 0;

    while (true) {
      const result = await this.executor.run(role, context);
      options.onAttempt?.(result, recoveries + 1);

      if (result?.executionStatus !== 'FAILED') return result;
      if (recoveries >= this.maxRecoveries) {
        return { ...result, recoveryExhausted: true };
      }

      const incident = this.bridge.observe({
        taskId: context.taskId ?? context.featureId ?? null,
        runId: result.runId ?? null,
        runtimeKey: result.runtimeKey ?? null,
        execution: result,
      });
      if (!incident) return { ...result, recoveryExhausted: true };

      const recovered = await this.reliability.recover(incident.id);
      if (recovered.state !== 'RECOVERED') {
        return { ...result, recoveryExhausted: true, incidentId: recovered.id };
      }
      recoveries += 1;
    }
  }
}
