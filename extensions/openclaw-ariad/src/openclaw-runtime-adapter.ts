type SubagentRuntime = {
  run(input: Record<string, unknown>): Promise<{ runId: string; sessionKey?: string; runtime?: { harness?: string; provider?: string; model?: string } }>;
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
  pollTimeoutMs?: number;
  onSessionBound?: (binding: { sessionKey: string; projectId: string; taskId: string; role: string; attemptId: string }) => void;
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

const ROLE_OUTCOMES: Record<string, Set<string>> = {
  artist: new Set(['PASS', 'NOT_PASS', 'NEEDS_CAPABILITY']),
  developer: new Set(['PASS', 'NOT_PASS']),
  tester: new Set(['PASS', 'NOT_PASS']),
  reviewer: new Set(['PASS', 'NOT_PASS']),
  project_debugger: new Set(['WRONG_IMPLEMENTATION_APPROACH', 'TASK_TOO_LARGE', 'ASSET_ISSUE', 'NEEDS_HUMAN']),
  tech_lead: new Set(['PLANNED', 'REPLANNED']),
  tech_lead_critic: new Set(['CLEAN', 'MINOR_ONLY', 'ISSUES']),
  pm: new Set(['PLAN_ACCEPTED', 'PLAN_REVISION_REQUIRED', 'NEEDS_HUMAN']),
};

function parseUnavailableResultToolFallback(
  text: string,
  binding: { attemptId: string; role: string } | undefined,
  runtime: { harness?: string; provider?: string; model?: string } | undefined,
) {
  if (!binding) return null;
  let parsed: any;
  try {
    parsed = parseJsonText(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.resultTool !== 'unavailable') return null;
  if (parsed.attemptId !== binding.attemptId) return null;
  const outcome = typeof parsed.outcome === 'string' ? parsed.outcome : '';
  if (!ROLE_OUTCOMES[binding.role]?.has(outcome)) return null;
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : `${binding.role} completed with the Ariad result tool unavailable in the selected harness.`;
  return {
    source: 'terminal_json_result_tool_unavailable',
    attemptId: binding.attemptId,
    role: binding.role,
    outcome,
    summary,
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.filter((value: unknown): value is string => typeof value === 'string')
      : [],
    artifacts: Array.isArray(parsed.artifacts)
      ? parsed.artifacts.filter((value: unknown): value is string => typeof value === 'string')
      : [],
    result: parsed.result ?? null,
    runtime: runtime ? { ...runtime } : null,
    raw: parsed,
  };
}

export class OpenClawRuntimeAdapter {
  readonly id = 'openclaw-subagent';
  private readonly subagent: SubagentRuntime;
  private readonly agentId: string;
  private readonly provider?: string;
  private readonly model?: string;
  private readonly renderMessage: (role: string, context: Record<string, unknown>) => string;
  private readonly cancelRun?: (runId: string) => Promise<unknown> | unknown;
  private readonly pollTimeoutMs: number;
  private readonly onSessionBound?: RuntimeAdapterOptions['onSessionBound'];
  private readonly sessions = new Map<string, string>();
  private readonly attempts = new Map<string, string>();
  private readonly bindings = new Map<string, { attemptId: string; role: string }>();
  private readonly runtimes = new Map<string, { harness?: string; provider?: string; model?: string }>();

  constructor(options: RuntimeAdapterOptions) {
    if (!options?.subagent?.run || !options?.subagent?.waitForRun) throw new Error('OpenClaw subagent runtime is required');
    this.subagent = options.subagent;
    this.agentId = options.agentId ?? 'main';
    this.provider = options.provider;
    this.model = options.model;
    this.renderMessage = options.renderMessage ?? ((role, context) => JSON.stringify({ role, context }));
    this.cancelRun = options.cancelRun;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 5_000;
    this.onSessionBound = options.onSessionBound;
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
    const stableIdentity = context.sessionPolicy === 'persistent' && typeof context.projectId === 'string'
      ? `persistent-${context.projectId}-${input.role}`
      : input.runId;
    const requestedSessionKey = sessionKey(this.agentId, stableIdentity);
    const roleBinding = (
      typeof context.projectId === 'string'
      && typeof context.taskId === 'string'
      && typeof context.attemptId === 'string'
    ) ? {
      projectId: context.projectId,
      taskId: context.taskId,
      role: input.role,
      attemptId: context.attemptId,
    } : null;

    // Tool factories are resolved as the subagent run starts, so bind the
    // requested session before run() to make the role-specific result tool
    // visible during this very invocation.
    if (roleBinding) {
      this.onSessionBound?.({ sessionKey: requestedSessionKey, ...roleBinding });
    }

    const selectedProvider = typeof context.provider === 'string' && context.provider.trim()
      ? context.provider.trim()
      : this.provider;
    const selectedModel = typeof context.model === 'string' && context.model.trim()
      ? context.model.trim()
      : this.model;
    const launched = await this.subagent.run({
      sessionKey: requestedSessionKey,
      message: this.renderMessage(input.role, context),
      promptMode: 'minimal',
      deliver: false,
      ...(workspace ? { cwd: workspace } : {}),
      ...(selectedProvider ? { provider: selectedProvider } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(typeof context.resultToolName === 'string' && context.resultToolName.trim()
        ? { toolsAlsoAllow: [context.resultToolName.trim()] }
        : {}),
    });
    if (!launched?.runId) throw new Error('OpenClaw subagent.run returned no runId');
    const boundSessionKey = launched.sessionKey ?? requestedSessionKey;
    this.sessions.set(launched.runId, boundSessionKey);
    if (launched.runtime) this.runtimes.set(launched.runId, { ...launched.runtime });
    if (roleBinding) {
      this.attempts.set(roleBinding.attemptId, launched.runId);
      this.bindings.set(launched.runId, { attemptId: roleBinding.attemptId, role: roleBinding.role });
    }
    if (roleBinding && boundSessionKey !== requestedSessionKey) {
      this.onSessionBound?.({ sessionKey: boundSessionKey, ...roleBinding });
    }
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
    const observed = await this.subagent.waitForRun({ runId: handle.externalId, timeoutMs: this.pollTimeoutMs });
    const status = String(observed?.status ?? 'pending');
    if (status === 'pending' || status === 'timeout') return { state: 'RUNNING' };
    if (status === 'error') return { state: 'FAILED', failure: String(observed?.error ?? observed?.stopReason ?? 'OPENCLAW_RUN_FAILED') };
    if (status !== 'ok') return { state: 'FAILED', failure: `UNKNOWN_OPENCLAW_STATUS:${status}` };

    const parseResult = (text: string) => {
      const result = parseJsonText(text);
      if (result?.executionStatus === 'FAILED') return { state: 'FAILED', failure: result.failure ?? 'ROLE_EXECUTION_FAILED' };
      return { state: 'COMPLETED', outcome: result?.outcome ?? null, result: result?.result ?? result };
    };

    const terminalText = extractText(observed?.terminalReply);
    if (terminalText) {
      const fallback = parseUnavailableResultToolFallback(
        terminalText,
        this.bindings.get(handle.externalId),
        this.runtimes.get(handle.externalId),
      );
      if (fallback) {
        return {
          state: 'COMPLETED',
          outcome: fallback.outcome,
          result: fallback.result,
          roleResultFallback: fallback,
        };
      }
      try {
        return parseResult(terminalText);
      } catch {
        // OpenClaw terminalReply may be display-truncated. Fall through to the durable
        // session transcript, which preserves the full assistant message.
      }
    }

    const key = this.sessions.get(handle.externalId);
    if (key && this.subagent.getSessionMessages) {
      const session = await this.subagent.getSessionMessages({ sessionKey: key, limit: 10 });
      const sessionText = extractText(session?.messages ?? null);
      if (sessionText) {
        const fallback = parseUnavailableResultToolFallback(
          sessionText,
          this.bindings.get(handle.externalId),
          this.runtimes.get(handle.externalId),
        );
        if (fallback) {
          return {
            state: 'COMPLETED',
            outcome: fallback.outcome,
            result: fallback.result,
            roleResultFallback: fallback,
          };
        }
        try {
          return parseResult(sessionText);
        } catch (error) {
          return { state: 'FAILED', failure: `INVALID_ROLE_RESULT:${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }

    if (!terminalText) return { state: 'FAILED', failure: 'OPENCLAW_RUN_COMPLETED_WITHOUT_RESULT' };
    try {
      return parseResult(terminalText);
    } catch (error) {
      return { state: 'FAILED', failure: `INVALID_ROLE_RESULT:${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async terminateAttempt(attemptId: string) {
    const externalId = this.attempts.get(attemptId);
    if (!externalId) return { requested: false, reason: 'ATTEMPT_NOT_BOUND' };
    if (!this.cancelRun) return { requested: false, reason: 'CANCEL_UNAVAILABLE' };
    this.attempts.delete(attemptId);
    await this.cancelRun(externalId);
    return { requested: true, externalId };
  }

  async cancel(handle: { externalId: string }) {
    if (this.cancelRun) await this.cancelRun(handle.externalId);
    return { state: 'CANCELLED' };
  }
}
