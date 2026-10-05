import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import {
  ARIAD_PI_DEFAULT_TOOLS,
  buildAriadPiModelsConfig,
  ariadPiPaths,
  resolveAriadPiModelRef,
} from './pi-runtime-config.js';

const RESULT_TOOL = 'ariad_role_result';

function resultToolSchema() {
  return Type.Object({
    outcome: Type.String({ minLength: 1 }),
    summary: Type.String({ minLength: 1 }),
    keyPoints: Type.Optional(Type.Array(Type.String())),
    artifacts: Type.Optional(Type.Array(Type.String())),
    result: Type.Optional(Type.Any()),
  }, { additionalProperties: false });
}

function ensureJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function createDefaultPiRunSession(spec) {
  const workspace = spec.workspace || process.cwd();
  const roleModels = spec.context?.roleModels ?? {};
  const modelRef = spec.context?.roleModelRef;
  if (!modelRef) throw new Error(`No explicit Ariad model configured for role ${spec.role}`);

  const target = resolveAriadPiModelRef(modelRef);
  const paths = ariadPiPaths(workspace);
  mkdirSync(paths.root, { recursive: true });
  if (!spec.context?.preservePiConfig) {
    ensureJson(paths.modelsPath, buildAriadPiModelsConfig(roleModels));
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    allowModelNetwork: true,
  });

  if (target.provider === 'meta' && process.env.META_API_KEY) {
    await modelRuntime.setRuntimeApiKey('meta', process.env.META_API_KEY);
  }

  const model = modelRuntime.getModel(target.provider, target.model);
  if (!model) {
    throw new Error(
      `MODEL_PROVIDER_UNAVAILABLE: provider=${target.provider} model=${target.model} configuredRef=${modelRef}`,
    );
  }

  let terminalResult = null;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: paths.root,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerTool({
        name: RESULT_TOOL,
        label: 'Ariad role result',
        description: 'Submit the authoritative structured result for this Ariad role. This must be the final action.',
        parameters: resultToolSchema(),
        async execute(_toolCallId, params) {
          terminalResult = {
            outcome: params.outcome,
            summary: params.summary,
            keyPoints: params.keyPoints ?? [],
            artifacts: params.artifacts ?? [],
            result: params.result ?? null,
          };
          return {
            content: [{ type: 'text', text: 'Ariad role result accepted.' }],
            details: { accepted: true },
            terminate: true,
          };
        },
      });
    }],
  });
  await loader.reload();

  const persistent = spec.sessionPolicy === 'persistent';
  const sessionManager = persistent
    ? SessionManager.create(workspace)
    : SessionManager.inMemory(workspace);

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: paths.root,
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    tools: [...ARIAD_PI_DEFAULT_TOOLS, RESULT_TOOL],
  });
  await session.bindExtensions({ mode: 'json' });

  return {
    session,
    getTerminalResult: () => terminalResult,
  };
}

export class PiAgentSessionProvider {
  constructor({ createRunSession = createDefaultPiRunSession } = {}) {
    this.id = 'pi-agent-session';
    this.createRunSession = createRunSession;
    this.runs = new Map();
    this.sequence = 0;
  }

  async start(spec) {
    if (!spec?.projectId || !spec?.taskId || !spec?.role) {
      throw new Error('PiAgentSessionProvider requires projectId, taskId, and role');
    }
    const externalId = `pi:${spec.projectId}:${spec.taskId}:${++this.sequence}`;
    const record = {
      state: 'RUNNING',
      result: null,
      failure: null,
      session: null,
      startedAt: new Date().toISOString(),
    };
    this.runs.set(externalId, record);

    const prompt = [
      spec.prompt ?? '',
      '',
      'ARIAD RUNTIME CONTEXT',
      JSON.stringify({
        projectId: spec.projectId,
        taskId: spec.taskId,
        role: spec.role,
        attemptId: spec.attemptId ?? null,
        sessionPolicy: spec.sessionPolicy ?? 'fresh',
      }),
      '',
      `When the assigned role work is actually complete, call ${RESULT_TOOL} exactly once. Do not finish with ordinary prose.`,
    ].join('\n');

    record.promise = (async () => {
      try {
        const run = await this.createRunSession(spec);
        record.session = run.session;
        await run.session.prompt(prompt);
        const result = run.getTerminalResult?.() ?? null;
        if (!result) throw new Error('ARIAD_ROLE_RESULT_MISSING: Pi session ended without terminal result tool');
        record.result = result;
        record.state = 'COMPLETED';
      } catch (error) {
        record.failure = error instanceof Error ? error.message : String(error);
        record.state = record.state === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      } finally {
        try { record.session?.dispose?.(); } catch {}
      }
    })();

    return { externalId };
  }

  async poll(handle) {
    const record = this.runs.get(handle.externalId);
    if (!record) return { state: 'LOST', failure: 'PI_RUN_NOT_FOUND', restartOrphan: true };
    if (record.state === 'COMPLETED') {
      return {
        state: 'COMPLETED',
        ...record.result,
      };
    }
    if (record.state === 'FAILED' || record.state === 'CANCELLED') {
      return { state: record.state, failure: record.failure ?? 'PI_RUN_FAILED' };
    }
    return { state: record.state };
  }

  async cancel(handle) {
    const record = this.runs.get(handle.externalId);
    if (!record) return { state: 'NOT_FOUND', confirmed: true };
    record.state = 'CANCELLED';
    record.failure = 'PI_RUN_CANCELLED';
    try { await record.session?.abort?.(); } catch {}
    return { state: 'CANCELLED', confirmed: true };
  }

  async close() {
    for (const [externalId] of this.runs) {
      await this.cancel({ externalId });
    }
  }
}

export { RESULT_TOOL as ARIAD_PI_RESULT_TOOL };
