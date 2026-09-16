export class Coordinator {
  constructor({ scheduler, applyExecutionResult }) {
    if (!scheduler || typeof scheduler.tryDispatch !== 'function') throw new Error('Coordinator requires scheduler');
    if (typeof applyExecutionResult !== 'function') throw new Error('Coordinator requires applyExecutionResult');
    this.scheduler = scheduler;
    this.applyExecutionResult = applyExecutionResult;
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
      outcomes.push({ work, status:'APPLIED', execution:scheduled.result, transition });
    }
    return outcomes;
  }
}
