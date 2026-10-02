import { randomUUID } from 'node:crypto';
import { roleResultPromptGuidance } from './role-result-tools.js';

type AgentRuntime = {
  runEmbeddedAgent(input: Record<string, unknown>): Promise<any>;
  resolveAgentWorkspaceDir?(cfg: any, agentId: string): string;
  resolveAgentDir?(cfg: any, agentId: string): string;
  resolveAgentTimeoutMs?(cfg: any): number;
  session?: {
    getSessionEntry?(input: { agentId: string; sessionKey: string }): any;
  };
};

type AgentSessionRuntimeOptions = {
  agent: AgentRuntime;
  config: () => any;
  pluginId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  renderMessage?: (role: string, context: Record<string, unknown>) => string;
  onSessionBound?: (binding: { sessionKey: string; projectId: string; taskId: string; role: string; attemptId: string }) => void;
};

type Binding = {
  projectId: string;
  taskId: string;
  attemptId: string;
  role: string;
};

type ActiveRun = {
  externalId: string;
  sessionId: string;
  sessionKey: string;
  binding?: Binding;
  runtime?: { harness?: string; provider?: string; model?: string };
  resultToolName?: string;
  workspaceDir: string;
  agentDir?: string;
  timeoutMs?: number;
  controller: AbortController;
  state: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  result?: any;
  error?: unknown;
};

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
}

function extractText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const found = extractText(value[i]);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['terminalReply', 'text', 'content', 'message', 'reply']) {
    const found = extractText(record[key]);
    if (found) return found;
  }
  return null;
}

function parseJsonText(text: string) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

/**
 * Executes Ariad roles as first-class OpenClaw agent sessions instead of
 * gateway subagents. The agent is a single execution host; isolation lives in
 * the session key. No Ariad DB schema changes are required.
 */
export class OpenClawAgentSessionRuntimeAdapter {
  readonly id = 'openclaw-agent-session';
  private readonly agent: AgentRuntime;
  private readonly config: () => any;
  private readonly pluginId: string;
  private readonly agentId: string;
  private readonly provider?: string;
  private readonly model?: string;
  private readonly renderMessage: (role: string, context: Record<string, unknown>) => string;
  private readonly onSessionBound?: AgentSessionRuntimeOptions['onSessionBound'];
  private readonly runs = new Map<string, ActiveRun>();
  private readonly attempts = new Map<string, string>();
  private readonly recoveryRuns = new Map<string, string>();

  constructor(options: AgentSessionRuntimeOptions) {
    if (!options?.agent?.runEmbeddedAgent) throw new Error('OpenClaw agent runtime is required');
    this.agent = options.agent;
    this.config = options.config;
    this.pluginId = options.pluginId ?? 'ariad';
    this.agentId = options.agentId ?? 'main';
    this.provider = options.provider;
    this.model = options.model;
    this.renderMessage = options.renderMessage ?? ((role, context) => JSON.stringify({ role, context }));
    this.onSessionBound = options.onSessionBound;
  }

  async install() { return { installed: true }; }
  async probe() { return { health: 'HEALTHY' as const }; }

  private sessionIdentity(runId: string, role: string, context: Record<string, unknown>) {
    if (context.sessionPolicy === 'persistent' && typeof context.projectId === 'string') {
      return `persistent-${safe(context.projectId)}-${safe(role)}`;
    }
    return `attempt-${safe(runId)}`;
  }

  private resolveSession(sessionKey: string, requestedSessionId: string) {
    const cfg = this.config();
    const existing = this.agent.session?.getSessionEntry?.({ agentId: this.agentId, sessionKey });
    return {
      sessionId: typeof existing?.sessionId === 'string' && existing.sessionId
        ? existing.sessionId
        : requestedSessionId,
      cfg,
    };
  }

  async start(input: { runId: string; role: string; context?: Record<string, unknown> }) {
    const context = input.context ?? {};
    const identity = this.sessionIdentity(input.runId, input.role, context);
    const sessionKey = `agent:${this.agentId}:ariad:${identity}`;
    const requestedSessionId = `ariad-${safe(identity)}-${randomUUID().slice(0, 8)}`;
    const workspace = typeof context.workspace === 'string' && context.workspace.trim() ? context.workspace.trim() : null;
    const binding = typeof context.projectId === 'string' && typeof context.taskId === 'string' && typeof context.attemptId === 'string'
      ? { projectId: context.projectId, taskId: context.taskId, attemptId: context.attemptId, role: input.role }
      : undefined;
    const selectedProvider = typeof context.provider === 'string' && context.provider.trim() ? context.provider.trim() : this.provider;
    const selectedModel = typeof context.model === 'string' && context.model.trim() ? context.model.trim() : this.model;
    const resultToolName = typeof context.resultToolName === 'string' && context.resultToolName.trim() ? context.resultToolName.trim() : undefined;
    const session = this.resolveSession(sessionKey, requestedSessionId);
    const cfg = session.cfg;
    const workspaceDir = workspace
      ?? this.agent.resolveAgentWorkspaceDir?.(cfg, this.agentId)
      ?? process.cwd();
    const agentDir = this.agent.resolveAgentDir?.(cfg, this.agentId);
    const timeoutMs = this.agent.resolveAgentTimeoutMs?.(cfg);
    const externalId = randomUUID();
    const controller = new AbortController();
    const active: ActiveRun = {
      externalId,
      sessionId: session.sessionId,
      sessionKey,
      binding,
      resultToolName,
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      controller,
      state: 'RUNNING',
      runtime: { provider: selectedProvider, model: selectedModel },
    };
    this.runs.set(externalId, active);
    if (binding) {
      this.attempts.set(binding.attemptId, externalId);
      this.onSessionBound?.({ sessionKey, ...binding });
    }

    void this.agent.runEmbeddedAgent({
      sessionId: session.sessionId,
      sessionKey,
      agentId: this.agentId,
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
      config: cfg,
      prompt: this.renderMessage(input.role, context),
      ...(selectedProvider ? { provider: selectedProvider } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      runId: externalId,
      trigger: 'manual',
      promptMode: 'minimal',
      terminalReplyExpectation: 'optional',
      runtimePluginToolGrant: resultToolName
        ? { pluginId: this.pluginId, toolNames: [resultToolName] }
        : undefined,
      abortSignal: controller.signal,
    }).then((result) => {
      active.result = result;
      active.runtime = {
        harness: result?.meta?.agentMeta?.agentHarnessId ?? result?.meta?.agentMeta?.harness,
        provider: result?.meta?.agentMeta?.provider ?? selectedProvider,
        model: result?.meta?.agentMeta?.model ?? selectedModel,
      };
      active.state = 'COMPLETED';
    }).catch((error) => {
      active.error = error;
      active.state = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
    });

    return { runtimeId: this.id, runId: input.runId, externalId, state: 'RUNNING' };
  }

  async resume(input: { runId: string; role: string; context?: Record<string, unknown>; checkpoint?: unknown }) {
    return this.start({
      runId: input.runId,
      role: input.role,
      context: { ...(input.context ?? {}), checkpoint: input.checkpoint ?? null, resumed: true },
    });
  }

  async poll(handle: { externalId: string }) {
    const active = this.runs.get(handle.externalId);
    if (!active) {
      return {
        state: 'LOST',
        failure: 'AGENT_SESSION_RUN_NOT_FOUND',
        consumeAttempt: false,
        restartOrphan: true,
      };
    }
    if (active.state === 'RUNNING') return { state: 'RUNNING' };
    if (active.state === 'CANCELLED') return { state: 'FAILED', failure: 'AGENT_SESSION_RUN_CANCELLED' };
    if (active.state === 'FAILED') {
      return { state: 'FAILED', failure: `AGENT_SESSION_RUN_FAILED:${active.error instanceof Error ? active.error.message : String(active.error)}` };
    }
    const metaError = active.result?.meta?.error;
    if (metaError) return { state: 'FAILED', failure: `AGENT_SESSION_RUN_FAILED:${String(metaError)}` };
    const terminalText = extractText(active.result?.terminalReply ?? active.result);
    if (!terminalText) {
      // Structured role-result tools are authoritative. A silent completed run is
      // intentionally left to Ariad's result-recovery/sealing path.
      return { state: 'COMPLETED', outcome: null, result: null };
    }
    try {
      const parsed = parseJsonText(terminalText);
      if (parsed?.executionStatus === 'FAILED') return { state: 'FAILED', failure: parsed.failure ?? 'ROLE_EXECUTION_FAILED' };
      return { state: 'COMPLETED', outcome: parsed?.outcome ?? null, result: parsed?.result ?? parsed };
    } catch {
      return { state: 'COMPLETED', outcome: null, result: { summary: terminalText } };
    }
  }

  async recoverRoleResult(handle: { externalId: string }, input: { attemptId: string; role: string }) {
    const active = this.runs.get(handle.externalId);
    if (!active?.binding || active.binding.attemptId !== input.attemptId || active.binding.role !== input.role) {
      return { state: 'FAILED', failure: 'ROLE_RESULT_RECOVERY_BINDING_MISMATCH' };
    }
    if (!active.resultToolName) {
      return { state: 'FAILED', failure: 'ROLE_RESULT_RECOVERY_TOOL_UNAVAILABLE' };
    }

    let recoveryExternalId = this.recoveryRuns.get(handle.externalId);
    if (!recoveryExternalId) {
      recoveryExternalId = randomUUID();
      const controller = new AbortController();
      const recovery: ActiveRun = {
        externalId: recoveryExternalId,
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        binding: active.binding,
        resultToolName: active.resultToolName,
        workspaceDir: active.workspaceDir,
        ...(active.agentDir ? { agentDir: active.agentDir } : {}),
        ...(active.timeoutMs ? { timeoutMs: active.timeoutMs } : {}),
        controller,
        state: 'RUNNING',
        runtime: active.runtime ? { ...active.runtime } : undefined,
      };
      this.runs.set(recoveryExternalId, recovery);
      this.recoveryRuns.set(handle.externalId, recoveryExternalId);

      const cfg = this.config();
      void this.agent.runEmbeddedAgent({
        sessionId: recovery.sessionId,
        sessionKey: recovery.sessionKey,
        agentId: this.agentId,
        workspaceDir: recovery.workspaceDir,
        ...(recovery.agentDir ? { agentDir: recovery.agentDir } : {}),
        config: cfg,
        prompt: [
          'ARIAD RESULT RECOVERY',
          `Your work for attempt ${input.attemptId} is already complete, but Ariad did not receive the required structured result.`,
          'Do not redo the task and do not change product files.',
          `Use the existing session context and artifacts, then call ${active.resultToolName} exactly once.`,
          `The attemptId MUST be exactly ${input.attemptId}.`,
          roleResultPromptGuidance(input.role, active.resultToolName, input.attemptId),
          'Recovery is only for correcting/submitting the structured result. Do not rerun tests, edit files, or repeat completed role work.',
          'The accepted result tool call must be your final action. Do not answer with prose or terminal JSON instead.',
        ].join('\n'),
        ...(active.runtime?.provider ? { provider: active.runtime.provider } : {}),
        ...(active.runtime?.model ? { model: active.runtime.model } : {}),
        ...(recovery.timeoutMs ? { timeoutMs: recovery.timeoutMs } : {}),
        runId: recoveryExternalId,
        trigger: 'manual',
        promptMode: 'minimal',
        terminalReplyExpectation: 'optional',
        runtimePluginToolGrant: { pluginId: this.pluginId, toolNames: [active.resultToolName] },
        abortSignal: controller.signal,
      }).then((result) => {
        recovery.result = result;
        recovery.state = 'COMPLETED';
      }).catch((error) => {
        recovery.error = error;
        recovery.state = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
      });
      return { state: 'RUNNING', recoveryRunId: recoveryExternalId };
    }

    const recovery = this.runs.get(recoveryExternalId);
    if (!recovery) return { state: 'FAILED', failure: 'ROLE_RESULT_RECOVERY_RUN_NOT_FOUND' };
    if (recovery.state === 'RUNNING') return { state: 'RUNNING', recoveryRunId: recoveryExternalId };
    if (recovery.state === 'FAILED') {
      return {
        state: 'FAILED',
        failure: `ROLE_RESULT_RECOVERY_FAILED:${recovery.error instanceof Error ? recovery.error.message : String(recovery.error)}`,
        recoveryRunId: recoveryExternalId,
      };
    }
    if (recovery.state === 'CANCELLED') {
      // Accepted result-tool submission aborts the recovery turn deliberately.
      return { state: 'COMPLETED', recoveryRunId: recoveryExternalId };
    }
    return {
      state: 'COMPLETED',
      recoveryRunId: recoveryExternalId,
      terminalReply: extractText(recovery.result?.terminalReply ?? recovery.result),
    };
  }

  getAttemptRuntimeBinding(attemptId: string) {
    const externalId = this.attempts.get(attemptId);
    if (!externalId) return null;
    const active = this.runs.get(externalId);
    if (!active?.binding) return null;
    return { ...active.binding, externalId, ...active.runtime };
  }

  async terminateAttempt(attemptId: string) {
    const externalId = this.attempts.get(attemptId);
    if (!externalId) return { requested: false, reason: 'ATTEMPT_NOT_BOUND' };
    const active = this.runs.get(externalId);
    if (!active) return { requested: false, reason: 'RUN_NOT_BOUND' };
    this.attempts.delete(attemptId);
    active.controller.abort(new Error('ARIAD_ROLE_RESULT_ACCEPTED'));
    const recoveryExternalId = this.recoveryRuns.get(externalId);
    if (recoveryExternalId) {
      this.runs.get(recoveryExternalId)?.controller.abort(new Error('ARIAD_ROLE_RESULT_ACCEPTED'));
    }
    return { requested: true, externalId, recoveryExternalId: recoveryExternalId ?? null };
  }

  async cancel(handle: { externalId: string }) {
    const active = this.runs.get(handle.externalId);
    if (active) active.controller.abort(new Error('ARIAD_CANCELLED'));
    const recoveryExternalId = this.recoveryRuns.get(handle.externalId);
    if (recoveryExternalId) this.runs.get(recoveryExternalId)?.controller.abort(new Error('ARIAD_CANCELLED'));
    return { state: 'CANCELLED' };
  }
}
