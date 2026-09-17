const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'NEEDS_HUMAN', 'WAITING_REPLAN']);

function requireState(state) {
  if (!state || typeof state !== 'object') throw new Error('transition requires workflow state');
  if (!Number.isInteger(state.devCycle) || state.devCycle < 1) throw new Error('state.devCycle must be >= 1');
  if (!Number.isInteger(state.strategyEpoch) || state.strategyEpoch < 1) throw new Error('state.strategyEpoch must be >= 1');
  if (typeof state.stage !== 'string' || !state.stage) throw new Error('state.stage is required');
  if (typeof state.status !== 'string' || !state.status) throw new Error('state.status is required');
}

function pauseSystem(result) {
  return {
    patch: { status: 'PAUSED_SYSTEM' },
    effect: {
      type: 'RELIABILITY_REQUIRED',
      failure: result?.failure ?? result?.runState ?? 'EXECUTION_FAILED',
      runId: result?.runId ?? null,
    },
  };
}

export class TransitionEngine {
  constructor(options = {}) {
    this.maxDevCycles = options.maxDevCycles ?? 3;
    this.maxStrategyEpochs = options.maxStrategyEpochs ?? 3;
  }

  next(state, role, result = {}) {
    requireState(state);
    if (TERMINAL_STATUSES.has(state.status)) throw new Error(`cannot transition terminal workflow state ${state.status}`);
    if (role !== state.stage) throw new Error(`role ${role} does not match workflow stage ${state.stage}`);

    if (result.executionStatus !== 'COMPLETED') return pauseSystem(result);

    if (role === 'developer') {
      return { patch: { stage: 'tester', status: 'RUNNING' }, effect: null };
    }

    if (role === 'tester' || role === 'reviewer') {
      if (result.outcome === 'PASS') {
        if (role === 'tester') return { patch: { stage: 'reviewer', status: 'RUNNING' }, effect: null };
        return {
          patch: { status: 'AWAITING_SOURCE_CONTROL' },
          effect: { type: 'FINALIZE_SOURCE_CONTROL' },
        };
      }
      if (result.outcome === 'NOT_PASS') {
        if (state.devCycle >= this.maxDevCycles) {
          return {
            patch: { stage: 'project_debugger', status: 'RUNNING' },
            effect: { type: 'ESCALATED_TO_PROJECT_DEBUGGER' },
          };
        }
        return {
          patch: { stage: 'developer', devCycle: state.devCycle + 1, status: 'RUNNING' },
          effect: null,
        };
      }
      return { patch: { status: 'NEEDS_HUMAN' }, effect: { type: 'INVALID_BUSINESS_OUTCOME' } };
    }

    if (role === 'project_debugger') {
      if (result.outcome === 'WRONG_IMPLEMENTATION_APPROACH') {
        if (state.strategyEpoch >= this.maxStrategyEpochs) {
          return { patch: { status: 'NEEDS_HUMAN' }, effect: { type: 'STRATEGY_EPOCHS_EXHAUSTED' } };
        }
        return {
          patch: {
            stage: 'developer',
            strategyEpoch: state.strategyEpoch + 1,
            devCycle: 1,
            status: 'RUNNING',
          },
          effect: { type: 'APPLY_STRATEGY_GUIDANCE', guidance: result.guidance ?? null },
        };
      }
      if (result.outcome === 'TASK_TOO_LARGE') {
        return {
          patch: { stage: 'tech_lead', status: 'RUNNING' },
          effect: { type: 'TECH_LEAD_REPLAN_REQUIRED', diagnosis: result.outcome },
        };
      }
      if (result.outcome === 'TASK_CONTRADICTORY') {
        return {
          patch: { status: 'NEEDS_HUMAN' },
          effect: { type: 'PRODUCT_REQUIREMENT_CONFLICT', diagnosis: result.outcome },
        };
      }
      return { patch: { status: 'NEEDS_HUMAN' }, effect: { type: 'UNKNOWN_PROJECT_CAUSE' } };
    }

    if (role === 'tech_lead') {
      if (result.outcome === 'NEEDS_HUMAN') {
        return { patch: { status: 'NEEDS_HUMAN' }, effect: null };
      }
      if (result.outcome === 'PLANNED' || result.outcome === 'REPLANNED') {
        return { patch: { status: 'WAITING_REPLAN' }, effect: { type: 'WORKFLOW_GRAPH_MUTATION_REQUIRED' } };
      }
      return { patch: { status: 'NEEDS_HUMAN' }, effect: { type: 'INVALID_BUSINESS_OUTCOME' } };
    }

    throw new Error(`unsupported workflow role ${role}`);
  }

  completeSourceControl(state, result = {}) {
    requireState(state);
    if (state.status !== 'AWAITING_SOURCE_CONTROL') throw new Error('source control completion requires AWAITING_SOURCE_CONTROL');
    if (result.ok) return { patch: { status: 'SUCCEEDED' }, effect: null };
    return {
      patch: { status: 'PAUSED_SYSTEM' },
      effect: { type: 'RELIABILITY_REQUIRED', failure: result.failure ?? 'SOURCE_CONTROL_FAILED', runId: null },
    };
  }
}
