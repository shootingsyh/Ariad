export class MockAgentHostProvider {
  constructor({ id = 'ariad-worker', worker = null } = {}) {
    this.id = id;
    this.worker = worker ?? (async request => ({ outcome: 'PASS', result: request.input ?? null }));
    this.sessions = new Map();
    this.bindings = new Map();
    this.results = new Map();
    this.nextSession = 1;
  }

  async start(request) {
    const sessionId = `${this.id}-session-${this.nextSession++}`;
    const binding = Object.freeze({
      hostAgentId: this.id,
      sessionId,
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      role: request.role,
    });
    this.sessions.set(sessionId, {
      hostAgentId: this.id,
      role: request.role,
      model: request.model ?? null,
      turns: [],
    });
    this.bindings.set(sessionId, binding);

    const submitResult = async payload => {
      const trusted = this.bindings.get(sessionId);
      if (!trusted) throw new Error(`unknown session binding: ${sessionId}`);
      const result = {
        state: 'COMPLETED',
        outcome: payload?.outcome ?? 'PASS',
        result: payload?.result ?? null,
        summary: payload?.summary ?? '',
        keyPoints: payload?.keyPoints ?? [],
        artifacts: payload?.artifacts ?? [],
        binding: trusted,
      };
      this.results.set(sessionId, result);
      return { accepted: true };
    };

    const session = this.sessions.get(sessionId);
    session.turns.push({ type: 'TASK', taskId: request.taskId });
    await this.worker({
      hostAgentId: this.id,
      role: request.role,
      model: request.model ?? null,
      prompt: request.prompt ?? request.context?.v2Prompt ?? '',
      context: request.context ?? null,
      submitResult,
    });

    return { externalId: sessionId, sessionId };
  }

  async poll(handle) {
    return this.results.get(handle.externalId) ?? { state: 'RUNNING' };
  }

  async cancel(handle) {
    this.results.delete(handle.externalId);
    this.bindings.delete(handle.externalId);
    return { state: 'CANCELLED' };
  }

  getBinding(sessionId) {
    return this.bindings.get(sessionId) ?? null;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }
}
