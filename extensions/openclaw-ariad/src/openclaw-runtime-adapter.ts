type SubagentRuntime = {
  run(input: Record<string, unknown>): Promise<{ runId: string; sessionKey?: string }>;
  waitForRun(input: { runId: string; timeoutMs?: number }): Promise<Record<string, unknown>>;
  getSessionMessages?(input: { sessionKey: string; limit?: number }): Promise<{ messages?: unknown[] }>;
};

type RuntimeAdapterOptions = {
  subagent: SubagentRuntime;
  agentId?: string;
  provider?: string;
  model?: string;
  renderMessage?: (role: string, context: Record<string, unknown>) => string;
  cancelRun?: (runId: string) => Promise<unknown> | unknown;
};

function parseJsonText(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

function extractText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'reply', 'terminalReply']) {
    const found = extractText(record[key]);
    if (found) return found;
  }
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const found = extractText(value[i]);
      if (found) return found;
    }
  }
  return null;
}

function sessionKey(agentId: string, runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return `agent:${agentId}:subagent:ariad-${safe}`;
}

export class OpenClawRuntimeAdapter {
  readonly id = 'openclaw-subagent';
  private readonly subagent: SubagentRuntime;
  private readonly agentId: string;
  private readonly provider?: string;
  private readonly model?: string;
  private readonly renderMessage: (role: string, context: Record<string, unknown>) => string;
  private readonly cancelRun?: (runId: string) => Promise<unknown> | unknown;
  private readonly sessions = new Map<string, string>();

  constructor(options: RuntimeAdapterOptions) {
    if (!options?.subagent?.run || !options?.subagent?.waitForRun) throw new Error('OpenClaw subagent runtime is required');
    this.subagent = options.subagent;
    this.agentId = options.agentId ?? 'main';
    this.provider = options.provider;
    this.model = options.model;
    this.renderMessage = options.renderMessage ?? ((role, context) => JSON.stringify({ role, context }));
    this.cancelRun = options.cancelRun;
  }

  async install() {
    return { installed: true };
  }

  async probe() {
    return { health: 'HEALTHY' as const };
  }

  async start(input: { runId: string; role: string; context?: Record<string, unknown> }) {
    const context = input.context ?? {};
    const workspace = typeof context.workspace === 'string' && context.workspace.trim() ? context.workspace : null;
    const requestedSessionKey = sessionKey(this.agentId, input.runId);
    const launched = await this.subagent.run({
      sessionKey: requestedSessionKey,
      message: this.renderMessage(input.role, context),
      promptMode: 'minimal',
      deliver: false,
      ...(workspace ? { cwd: workspace } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.model ? { model: this.model } : {}),
    });
    if (!launched?.runId) throw new Error('OpenClaw subagent.run returned no runId');
    this.sessions.set(launched.runId, launched.sessionKey ?? requestedSessionKey);
    return { runtimeId: this.id, runId: input.runId, externalId: launched.runId, state: 'RUNNING' };
  }

  async resume(input: { runId: string; role: string; context?: Record<string, unknown>; checkpoint?: unknown }) {
    return this.start({
      runId: input.runId,
      role: input.role,
      context: { ...(input.context ?? {}), checkpoint: input.checkpoint ?? null, resumed: true },
    });
  }

  async poll(handle: { externalId: string }) {
    const observed = await this.subagent.waitForRun({ runId: handle.externalId, timeoutMs: 25 });
    const status = String(observed?.status ?? 'pending');
    if (status === 'pending' || status === 'timeout') return { state: 'RUNNING' };
    if (status === 'error') return { state: 'FAILED', failure: String(observed?.error ?? observed?.stopReason ?? 'OPENCLAW_RUN_FAILED') };
    if (status !== 'ok') return { state: 'FAILED', failure: `UNKNOWN_OPENCLAW_STATUS:${status}` };

    let text = extractText(observed?.terminalReply);
    if (!text) {
      const key = this.sessions.get(handle.externalId);
      if (key && this.subagent.getSessionMessages) {
        const session = await this.subagent.getSessionMessages({ sessionKey: key, limit: 10 });
        text = extractText(session?.messages ?? null);
      }
    }
    if (!text) return { state: 'FAILED', failure: 'OPENCLAW_RUN_COMPLETED_WITHOUT_RESULT' };

    try {
      const result = parseJsonText(text);
      if (result?.executionStatus === 'FAILED') return { state: 'FAILED', failure: result.failure ?? 'ROLE_EXECUTION_FAILED' };
      return { state: 'COMPLETED', outcome: result?.outcome ?? null, result: result?.result ?? result };
    } catch (error) {
      return { state: 'FAILED', failure: `INVALID_ROLE_RESULT:${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async cancel(handle: { externalId: string }) {
    if (this.cancelRun) await this.cancelRun(handle.externalId);
    return { state: 'CANCELLED' };
  }
}
