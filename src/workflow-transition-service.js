export class WorkflowTransitionService {
  constructor({ store, engine }) {
    if (!store || typeof store.get !== 'function' || typeof store.update !== 'function') {
      throw new Error('WorkflowTransitionService requires workflow state store');
    }
    if (!engine || typeof engine.next !== 'function') throw new Error('WorkflowTransitionService requires transition engine');
    this.store = store;
    this.engine = engine;
  }

  async apply(work, result) {
    const taskId = work?.taskId ?? work?.context?.taskId;
    if (!taskId) throw new Error('work.taskId is required');
    const current = this.store.get(taskId);
    if (!current) throw new Error(`unknown workflow state: ${taskId}`);
    const transition = this.engine.next(current, work.role, result);
    const state = this.store.update(taskId, current.version, transition.patch);
    return { state, effect: transition.effect };
  }

  submitHumanDecision(taskId, decision) {
    const current = this.store.get(taskId);
    if (!current) throw new Error(`unknown workflow state: ${taskId}`);
    if (typeof this.engine.resumeHumanDecision !== 'function') throw new Error('transition engine does not support human decisions');
    const transition = this.engine.resumeHumanDecision(current, decision);
    const state = this.store.update(taskId, current.version, transition.patch);
    return { state, effect: transition.effect };
  }

  completeSourceControl(taskId, result) {
    const current = this.store.get(taskId);
    if (!current) throw new Error(`unknown workflow state: ${taskId}`);
    const transition = this.engine.completeSourceControl(current, result);
    const state = this.store.update(taskId, current.version, transition.patch);
    return { state, effect: transition.effect };
  }

  mergeContext(taskId, patch = {}) {
    const current = this.store.get(taskId);
    if (!current) throw new Error(`unknown workflow state: ${taskId}`);
    const context = { ...(current.context ?? {}), ...patch };
    return this.store.update(taskId, current.version, { context });
  }

  clearContext(taskId, keys = []) {
    const current = this.store.get(taskId);
    if (!current) throw new Error(`unknown workflow state: ${taskId}`);
    const context = { ...(current.context ?? {}) };
    for (const key of keys) delete context[key];
    return this.store.update(taskId, current.version, { context });
  }
}
