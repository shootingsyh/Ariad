export class Coordinator {
  constructor({ scheduler, applyExecutionResult, effectExecutor = null }) {
    if (!scheduler || typeof scheduler.tryDispatch !== 'function') throw new Error('Coordinator requires scheduler');
    if (typeof applyExecutionResult !== 'function') throw new Error('Coordinator requires applyExecutionResult');
    if (effectExecutor && typeof effectExecutor.execute !== 'function') throw new Error('effectExecutor must implement execute');
    this.scheduler = scheduler;
    this.applyExecutionResult = applyExecutionResult;
    this.effectExecutor = effectExecutor;
  }

  async tick(readyWork = []) {
    const outcomes=[];
    for (const work of readyWork) {
      const scheduled=await this.scheduler.tryDispatch(work);
      if (scheduled.status !== 'DISPATCHED') {
        outcomes.push({ work, ...scheduled });
        continue;
      }
      const transition=await this.applyExecutionResult(work, scheduled.result);
      let effectResult = null;
      if (this.effectExecutor && transition?.effect) {
        effectResult = await this.effectExecutor.execute({
          taskId: work.taskId ?? work.context?.taskId,
          state: transition.state,
          effect: transition.effect,
        });
      }
      outcomes.push({ work, status:'APPLIED', execution:scheduled.result, transition, effectResult });
    }
    return outcomes;
  }
}
