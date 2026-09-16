let nextRunId = 1;

export class InMemoryRunStore {
  constructor() {
    this.runs = new Map();
    this.order = [];
  }

  nextAttempt(taskId, role) {
    return this.order
      .map(id => this.runs.get(id))
      .filter(run => run.taskId === taskId && run.role === role)
      .length + 1;
  }

  create({ taskId, role, runtimeKey, runtimeId = null, context = {} }) {
    const id = `RUN-${nextRunId++}`;
    const run = {
      id,
      taskId,
      role,
      runtimeKey,
      runtimeId,
      attempt: this.nextAttempt(taskId, role),
      state: 'CREATED',
      externalId: null,
      context: structuredClone(context),
      result: null,
      failure: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(id, run);
    this.order.push(id);
    return structuredClone(run);
  }

  update(id, patch) {
    const current = this.runs.get(id);
    if (!current) throw new Error(`unknown run: ${id}`);
    const next = {
      ...current,
      ...structuredClone(patch),
      id: current.id,
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(id, next);
    return structuredClone(next);
  }

  get(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`unknown run: ${id}`);
    return structuredClone(run);
  }

  list() {
    return this.order.map(id => structuredClone(this.runs.get(id)));
  }
}
