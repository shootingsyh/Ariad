import { TransitionEngine } from './transition-engine.js';
import { ReliabilityExecutionExecutor } from './reliability-execution-executor.js';

function normalizeLegacyResult(role, result) {
  if (role === 'pm' && result?.outcome === 'REPLAN_READY') {
    return { ...result, outcome: 'REPLANNED' };
  }
  return result;
}

export class WorkflowEngine {
  constructor(executor, options = {}) {
    this.executor = options.executionExecutor ?? new ReliabilityExecutionExecutor({
      executor,
      reliability: options.reliability ?? null,
      bridge: options.executionReliabilityBridge ?? null,
      maxRecoveries: options.maxSystemRetries ?? 2,
    });
    this.maxStrategyEpochs = options.maxStrategyEpochs ?? 3;
    this.finalizeSourceControl = options.finalizeSourceControl ?? (async () => ({ ok: true }));
    this.transitions = options.transitionEngine ?? new TransitionEngine({
      maxDevCycles: 3,
      maxStrategyEpochs: this.maxStrategyEpochs,
    });
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

      let result = await this.executor.run(role, context, {
        onAttempt: attemptResult => {
          history.push({
            role,
            context: structuredClone(context),
            result: structuredClone(attemptResult),
          });
        },
      });
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
