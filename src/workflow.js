import { TransitionEngine } from './transition-engine.js';

function normalizeLegacyResult(role, result) {
  if (role === 'pm' && result?.outcome === 'REPLAN_READY') {
    return { ...result, outcome: 'REPLANNED' };
  }
  return result;
}

export class WorkflowEngine {
  constructor(executor, options = {}) {
    this.executor = executor;
    this.maxSystemRetries = options.maxSystemRetries ?? 2;
    this.maxStrategyEpochs = options.maxStrategyEpochs ?? 3;
    this.finalizeSourceControl = options.finalizeSourceControl ?? (async () => ({ ok: true }));
    this.transitions = options.transitionEngine ?? new TransitionEngine({
      maxDevCycles: 3,
      maxStrategyEpochs: this.maxStrategyEpochs,
    });
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
    let state = {
      taskId: featureId,
      stage: 'developer',
      devCycle: 1,
      strategyEpoch: 1,
      status: 'RUNNING',
    };
    const history = [];
    let pendingDiagnosis = null;

    while (true) {
      if (state.status === 'AWAITING_SOURCE_CONTROL') {
        const sc = await this.finalizeSourceControl({
          taskId: featureId,
          strategyEpoch: state.strategyEpoch,
          devCycle: state.devCycle,
        });
        history.push({
          role: 'source_control_step',
          context: { taskId: featureId, strategyEpoch: state.strategyEpoch, devCycle: state.devCycle },
          result: structuredClone(sc),
        });
        const completed = this.transitions.completeSourceControl(state, sc);
        state = { ...state, ...completed.patch };
        continue;
      }

      if (state.status !== 'RUNNING') {
        return {
          status: state.status,
          devCycle: state.devCycle,
          strategyEpoch: state.strategyEpoch,
          history,
        };
      }

      const role = state.stage;
      const context = {
        taskId: featureId,
        strategyEpoch: state.strategyEpoch,
        devCycle: state.devCycle,
      };
      if (role === 'pm' && pendingDiagnosis) context.diagnosis = pendingDiagnosis;

      let result = await this.runRoleWithSystemRetry(role, context, history);
      if (result.recoveryExhausted) {
        result = { ...result, executionStatus: 'FAILED' };
      }
      result = normalizeLegacyResult(role, result);

      const transition = this.transitions.next(state, role, result);
      state = { ...state, ...transition.patch };

      if (transition.effect?.type === 'PM_REPLAN_REQUIRED') {
        pendingDiagnosis = transition.effect.diagnosis;
      } else if (role === 'pm') {
        pendingDiagnosis = null;
      }
    }
  }
}
