import { randomUUID } from 'node:crypto';

type Pending = {
  status: 'pending' | 'ok' | 'error';
  terminalReply?: unknown;
  error?: unknown;
  controller: AbortController;
};

/**
 * Compatibility facade for the experiment branch. It implements the tiny
 * subagent runtime shape consumed by OpenClawRuntimeAdapter, but launches a
 * normal first-class embedded agent turn. This lets us validate the new
 * execution primitive on a real machine without changing Ariad's DB/provider.
 */
export function createAgentSessionSubagentFacade(api: any, options: { agentId: string; pluginId?: string }) {
  const pending = new Map<string, Pending>();
  const agentId = options.agentId;
  const pluginId = options.pluginId ?? 'ariad';

  const run = async (input: Record<string, any>) => {
    const cfg = api.runtime.config.current();
    const runId = randomUUID();
    const sessionKey = typeof input.sessionKey === 'string' && input.sessionKey
      ? input.sessionKey.replace(':subagent:', ':ariad-session:')
      : `agent:${agentId}:ariad-session:${runId}`;
    const existing = api.runtime.agent.session.getSessionEntry?.({ agentId, sessionKey });
    let sessionId = existing?.sessionId as string | undefined;
    if (!sessionId) {
      // OpenClaw's canonical session creator requires initialEntry even when the
      // plugin does not need to seed any trusted harness/backend metadata.
      // Keep it deliberately empty: Ariad wants an ordinary host-agent session,
      // not a plugin-owned harness/CLI/ACP session.
      const created = await api.runtime.agent.session.createSessionEntry({
        cfg,
        key: sessionKey,
        agentId,
        initialEntry: {},
        ...(typeof input.cwd === 'string' && input.cwd ? { spawnedCwd: input.cwd } : {}),
        displayName: `Ariad worker ${sessionKey.split(':').at(-1) ?? runId}`,
      });
      const entry = created?.entry ?? created;
      sessionId = typeof entry?.sessionId === 'string' && entry.sessionId ? entry.sessionId : `ariad-${runId}`;
    }
    const storePath = api.runtime.agent.session.resolveStorePath?.(cfg?.session?.store, { agentId });
    const controller = new AbortController();
    const state: Pending = { status: 'pending', controller };
    pending.set(runId, state);

    const toolNames = Array.isArray(input.toolsAlsoAllow)
      ? input.toolsAlsoAllow.filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
      : [];
    const workspaceDir = typeof input.cwd === 'string' && input.cwd
      ? input.cwd
      : api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = api.runtime.agent.resolveAgentDir?.(cfg, agentId);

    void api.runtime.agent.runEmbeddedAgent({
      sessionId,
      sessionKey,
      agentId,
      ...(storePath ? { sessionTarget: { agentId, sessionId, sessionKey, storePath } } : {}),
      workspaceDir,
      ...(agentDir ? { agentDir } : {}),
      config: cfg,
      prompt: String(input.message ?? ''),
      ...(typeof input.provider === 'string' && input.provider ? { provider: input.provider } : {}),
      ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
      timeoutMs: api.runtime.agent.resolveAgentTimeoutMs?.(cfg),
      runId,
      trigger: 'manual',
      promptMode: input.promptMode ?? 'minimal',
      terminalReplyExpectation: 'optional',
      // This is additive: unlike subagent toolsAllow, it grants Ariad's owned
      // optional result tool without replacing the normal MCP/tool surface.
      ...(toolNames.length ? { runtimePluginToolGrant: { pluginId, toolNames } } : {}),
      abortSignal: controller.signal,
    }).then((result: any) => {
      state.status = 'ok';
      state.terminalReply = result?.terminalReply ?? result?.reply ?? result;
    }).catch((error: unknown) => {
      if (controller.signal.aborted && String((controller.signal.reason as any)?.message ?? controller.signal.reason ?? '').includes('ARIAD_ROLE_RESULT_ACCEPTED')) {
        state.status = 'ok';
        state.terminalReply = null;
        return;
      }
      state.status = 'error';
      state.error = error;
    });

    return { runId, sessionKey, runtime: { provider: input.provider, model: input.model, harness: 'openclaw' } };
  };

  return {
    run,
    async waitForRun({ runId }: { runId: string; timeoutMs?: number }) {
      const state = pending.get(runId);
      if (!state) return { status: 'error', error: 'AGENT_SESSION_RUN_NOT_FOUND' };
      if (state.status === 'pending') return { status: 'pending' };
      if (state.status === 'error') return { status: 'error', error: state.error instanceof Error ? state.error.message : String(state.error) };
      return { status: 'ok', terminalReply: state.terminalReply };
    },
    async getSessionMessages({ sessionKey }: { sessionKey: string; limit?: number }) {
      try {
        return await api.runtime.gateway.request('sessions.get', { key: sessionKey });
      } catch {
        return { messages: [] };
      }
    },
    abort(runId: string, reason = 'ARIAD_CANCELLED') {
      const state = pending.get(runId);
      if (!state) return false;
      state.controller.abort(new Error(reason));
      return true;
    },
  };
}
