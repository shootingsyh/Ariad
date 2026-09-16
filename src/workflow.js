export class WorkflowEngine {
  constructor(executor, options = {}) {
    this.executor = executor;
    this.maxSystemRetries = options.maxSystemRetries ?? 2;
    this.maxStrategyEpochs = options.maxStrategyEpochs ?? 3;
    this.finalizeSourceControl = options.finalizeSourceControl ?? (async () => ({ ok: true }));
  }

  async runRoleWithSystemRetry(role, context, history) {
    let retries = 0;
    while (true) {
      const result = await this.executor.run(role, context);
      history.push({ role, context: structuredClone(context), result: structuredClone(result) });
      if (result.executionStatus !== 'FAILED') return result;
      if (retries >= this.maxSystemRetries) return { ...result, recoveryExhausted: true };
      retries += 1;
    }
  }

  async runFeature(featureId) {
    let devCycle = 1;
    let strategyEpoch = 1;
    const history = [];

    while (true) {
      if (devCycle > 3) {
        const dbg = await this.runRoleWithSystemRetry('project_debugger', { taskId: featureId, strategyEpoch, devCycle: devCycle - 1 }, history);
        if (dbg.recoveryExhausted) return { status: 'PAUSED_SYSTEM', devCycle: devCycle - 1, strategyEpoch, history };
        if (dbg.outcome === 'WRONG_IMPLEMENTATION_APPROACH') {
          if (strategyEpoch >= this.maxStrategyEpochs) return { status: 'NEEDS_HUMAN', devCycle: devCycle - 1, strategyEpoch, history };
          strategyEpoch += 1;
          devCycle = 1;
          continue;
        }
        if (dbg.outcome === 'TASK_TOO_LARGE' || dbg.outcome === 'TASK_CONTRADICTORY') {
          const pm = await this.runRoleWithSystemRetry('pm', { taskId: featureId, strategyEpoch, devCycle: devCycle - 1, diagnosis: dbg.outcome }, history);
          if (pm.recoveryExhausted) return { status: 'PAUSED_SYSTEM', devCycle: devCycle - 1, strategyEpoch, history };
          if (pm.outcome === 'NEEDS_HUMAN') return { status: 'NEEDS_HUMAN', devCycle: devCycle - 1, strategyEpoch, history };
          return { status: 'WAITING_REPLAN', devCycle: devCycle - 1, strategyEpoch, history };
        }
        return { status: 'NEEDS_HUMAN', devCycle: devCycle - 1, strategyEpoch, history };
      }

      const dev = await this.runRoleWithSystemRetry('developer', { taskId: featureId, strategyEpoch, devCycle }, history);
      if (dev.recoveryExhausted) return { status: 'PAUSED_SYSTEM', devCycle, strategyEpoch, history };

      const tester = await this.runRoleWithSystemRetry('tester', { taskId: featureId, strategyEpoch, devCycle }, history);
      if (tester.recoveryExhausted) return { status: 'PAUSED_SYSTEM', devCycle, strategyEpoch, history };
      if (tester.outcome === 'NOT_PASS') { devCycle += 1; continue; }
      if (tester.outcome !== 'PASS') return { status: 'NEEDS_HUMAN', devCycle, strategyEpoch, history };

      const reviewer = await this.runRoleWithSystemRetry('reviewer', { taskId: featureId, strategyEpoch, devCycle }, history);
      if (reviewer.recoveryExhausted) return { status: 'PAUSED_SYSTEM', devCycle, strategyEpoch, history };
      if (reviewer.outcome === 'NOT_PASS') { devCycle += 1; continue; }
      if (reviewer.outcome === 'PASS') {
        const sc = await this.finalizeSourceControl({ taskId: featureId, strategyEpoch, devCycle });
        history.push({ role: 'source_control_step', context: { taskId: featureId, strategyEpoch, devCycle }, result: structuredClone(sc) });
        if (!sc?.ok) return { status: 'PAUSED_SYSTEM', devCycle, strategyEpoch, history };
        return { status: 'SUCCEEDED', devCycle, strategyEpoch, history };
      }
      return { status: 'NEEDS_HUMAN', devCycle, strategyEpoch, history };
    }
  }
}
