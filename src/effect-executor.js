export class EffectExecutor {
  constructor({ transitionService, finalizeSourceControl = async () => ({ ok: true }), mutateWorkflowGraph = async () => ({ ok: true }) }) {
    if (!transitionService || typeof transitionService.completeSourceControl !== 'function' || typeof transitionService.mergeContext !== 'function') {
      throw new Error('EffectExecutor requires workflow transition service');
    }
    if (typeof finalizeSourceControl !== 'function') throw new Error('finalizeSourceControl must be a function');
    if (typeof mutateWorkflowGraph !== 'function') throw new Error('mutateWorkflowGraph must be a function');
    this.transitionService = transitionService;
    this.finalizeSourceControl = finalizeSourceControl;
    this.mutateWorkflowGraph = mutateWorkflowGraph;
  }

  async execute({ taskId, state, effect }) {
    if (!effect) return { state, effect: null, result: null };
    if (!taskId) throw new Error('effect execution requires taskId');

    if (effect.type === 'FINALIZE_SOURCE_CONTROL') {
      const result = await this.finalizeSourceControl({
        taskId,
        strategyEpoch: state.strategyEpoch,
        devCycle: state.devCycle,
      });
      const transition = this.transitionService.completeSourceControl(taskId, result);
      return { ...transition, result };
    }

    if (effect.type === 'PM_REPLAN_REQUIRED') {
      const next = this.transitionService.mergeContext(taskId, { diagnosis: effect.diagnosis });
      return { state: next, effect: null, result: { persisted: true } };
    }

    if (effect.type === 'APPLY_STRATEGY_GUIDANCE') {
      const next = this.transitionService.mergeContext(taskId, { guidance: effect.guidance ?? null });
      return { state: next, effect: null, result: { persisted: true } };
    }

    if (effect.type === 'WORKFLOW_GRAPH_MUTATION_REQUIRED') {
      const result = await this.mutateWorkflowGraph({ taskId, state, context: state.context ?? {} });
      return { state, effect: null, result };
    }

    return { state, effect, result: null };
  }
}
