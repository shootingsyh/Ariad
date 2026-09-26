export class MockAgentHostProvider {
  constructor({ id = 'mock-agent-host', worker = null } = {}) {
    this.id = id;
    this.worker = worker ?? (async request => ({ outcome: 'PASS', result: request.input ?? null }));
    this.sessions = new Map();
    this.bindings = new Map();
    this.results = new Map();
    this.nextSession = 1;
  }

  async start(request) {
    const sessionId = `${request.role}-session-${this.nextSession++}`;
    const binding = Object.freeze({
      sessionId,
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      role: request.role,
    });
    this.sessions.set(sessionId, { role: request.role, turns: [] });
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
      role: request.role,
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
}
