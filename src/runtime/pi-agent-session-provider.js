import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { buildStandaloneRolePrompt } from './role-run-prompt.js';
import { migrateLegacyPiAuth } from './pi-auth-migration.js';
import { ARIAD_PROJECT_TOOL_NAMES, registerAriadProjectTools } from './pi-project-tools.js';

import {
  ARIAD_PI_DEFAULT_TOOLS,
  buildAriadPiModelsConfig,
  ariadPiPaths,
  resolveAriadPiModelRef,
} from './pi-runtime-config.js';

const RESULT_TOOL = 'ariad_role_result';

const ROLE_RESULT_OUTCOMES = Object.freeze({
  artist: ['PASS', 'NOT_PASS', 'NEEDS_CAPABILITY'],
  developer: ['PASS', 'NOT_PASS'],
  tester: ['PASS', 'NOT_PASS'],
  reviewer: ['PASS', 'NOT_PASS'],
  project_debugger: [
    'WRONG_IMPLEMENTATION_APPROACH',
    'TASK_TOO_LARGE',
    'ASSET_ISSUE',
    'REQUIREMENT_DECISION_REQUIRED',
    'SYSTEM_RUNTIME_FAILURE',
    'MODEL_CAPABILITY_MISMATCH',
    'UNKNOWN_PROJECT_CAUSE',
  ],
  tech_lead: ['PLANNED', 'REPLANNED'],
  tech_lead_critic: ['CLEAN', 'MINOR_ONLY', 'ISSUES'],
  pm: ['PLAN_ACCEPTED', 'PLAN_REVISION_REQUIRED', 'PRODUCT_DECISION', 'NEEDS_HUMAN'],
  memory_curator: ['PASS', 'NOT_PASS'],
});

const anchorSchema = Type.Object({
  kind: Type.Union([Type.Literal('symbol'), Type.Literal('range')]),
  file: Type.String({ minLength: 1 }),
  symbol: Type.Optional(Type.String({ minLength: 1 })),
  startLine: Type.Optional(Type.Integer({ minimum: 1 })),
  endLine: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const commonFields = {
  summary: Type.String({ minLength: 1 }),
  keyPoints: Type.Optional(Type.Array(Type.String())),
  artifacts: Type.Optional(Type.Array(Type.String())),
};

function openResult(fields = {}) {
  return Type.Object(fields, { additionalProperties: true });
}

export function piRoleResultToolSchema(role) {
  const outcomes = ROLE_RESULT_OUTCOMES[role];
  const outcome = outcomes
    ? Type.Union(outcomes.map(value => Type.Literal(value)))
    : Type.String({ minLength: 1 });

  let result = Type.Optional(openResult());
  if (role === 'developer') {
    result = Type.Optional(openResult({
      interfaceRealizations: Type.Optional(Type.Array(Type.Object({
        interfaceId: Type.String({ minLength: 1 }),
        anchors: Type.Array(anchorSchema),
      }, { additionalProperties: false }))),
    }));
  } else if (role === 'tester') {
    result = Type.Object({
      criteria: Type.Array(Type.Object({
        criterionId: Type.String({ minLength: 1 }),
        status: Type.Union([
          Type.Literal('SATISFIED'),
          Type.Literal('FAILED'),
          Type.Literal('UNVERIFIED'),
          Type.Literal('BLOCKED'),
        ]),
        evidenceType: Type.Union([
          Type.Literal('runtime'),
          Type.Literal('static'),
          Type.Literal('behavioral'),
          Type.Literal('proxy'),
          Type.Literal('manual'),
        ]),
        evidence: Type.Array(Type.Any()),
        reason: Type.String({ minLength: 1 }),
      }, { additionalProperties: false })),
      interfaceVerifications: Type.Optional(Type.Array(Type.Object({
        interfaceId: Type.String({ minLength: 1 }),
        evidence: Type.Array(Type.Any()),
        anchors: Type.Optional(Type.Array(anchorSchema)),
      }, { additionalProperties: false }))),
    }, { additionalProperties: true });
  } else if (role === 'reviewer') {
    result = Type.Optional(openResult({
      interfaceReviews: Type.Optional(Type.Array(Type.Object({
        interfaceId: Type.String({ minLength: 1 }),
        status: Type.Literal('APPROVED'),
        reason: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }))),
    }));
  } else if (role === 'tech_lead_critic') {
    result = Type.Object({
      issues: Type.Array(Type.Object({
        severity: Type.Union([
          Type.Literal('error'),
          Type.Literal('major'),
          Type.Literal('minor'),
        ]),
        message: Type.String({ minLength: 1 }),
      }, { additionalProperties: false })),
      summary: Type.String({ minLength: 1 }),
    }, { additionalProperties: true });
  } else if (role === 'pm') {
    result = Type.Object({
      reason: Type.String({ minLength: 1 }),
      startDelivery: Type.Optional(Type.Boolean()),
      guidance: Type.Optional(Type.String()),
      decision: Type.Optional(Type.String()),
      customerOutcomeSummary: Type.Optional(Type.String()),
      questions: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: true });
  }

  return Type.Object({
    outcome,
    ...commonFields,
    result,
  }, { additionalProperties: false });
}

function ensureJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function piSessionManagerForSpec(spec, paths, workspace) {
  const persistent = spec.sessionPolicy === 'persistent';
  const identity = persistent
    ? String(spec.sessionKey ?? spec.context?.sessionKey ?? '').trim()
    : String(spec.attemptId ?? spec.runId ?? `${spec.projectId ?? 'project'}:${spec.taskId ?? 'task'}:${spec.role ?? 'role'}:${Date.now()}`);
  if (persistent && !identity) throw new Error(`Persistent Pi role ${spec.role} requires sessionKey`);

  const sessionHash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const scope = persistent ? 'persistent' : 'fresh';
  const sessionDir = join(paths.sessionsDir, scope, sessionHash);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'ariad-session.json'), JSON.stringify({
    projectId: spec.projectId ?? null,
    taskId: spec.taskId ?? null,
    role: spec.role ?? null,
    attemptId: spec.attemptId ?? null,
    sessionPolicy: persistent ? 'persistent' : 'fresh',
    sessionKey: persistent ? identity : null,
  }, null, 2) + '\n', 'utf8');

  return persistent
    ? SessionManager.continueRecent(workspace, sessionDir)
    : SessionManager.create(workspace, sessionDir);
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
    migrateLegacyPiAuth(paths.authPath, { providers: [target.provider] });
  }
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
      registerAriadProjectTools(pi, { workspace });
      pi.registerTool({
        name: RESULT_TOOL,
        label: 'Ariad role result',
        description: 'Submit the authoritative structured result for this Ariad role. Arguments are strictly validated. Use only the outcome values and result shape allowed by this tool schema. This must be the final action.',
        parameters: piRoleResultToolSchema(spec.role),
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

  const sessionManager = piSessionManagerForSpec(spec, paths, workspace);

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: paths.root,
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    tools: [...ARIAD_PI_DEFAULT_TOOLS, ...ARIAD_PROJECT_TOOL_NAMES, RESULT_TOOL],
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

    const rolePrompt = buildStandaloneRolePrompt(spec.context ?? {}, spec.prompt ?? '');
    const prompt = [
      rolePrompt,
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
        if (!result) {
          const last = Array.isArray(run.session?.messages) ? run.session.messages.at(-1) : null;
          if (last?.role === 'assistant' && last?.stopReason === 'error' && last?.errorMessage) {
            throw new Error(`PI_PROVIDER_ERROR: ${last.errorMessage}`);
          }
          throw new Error('ARIAD_ROLE_RESULT_MISSING: Pi session ended without terminal result tool');
        }
        record.result = result;
        record.state = 'COMPLETED';
      } catch (error) {
        if (record.state === 'CANCELLED') {
          record.failure = record.failure ?? 'PI_RUN_CANCELLED';
        } else {
          record.failure = error instanceof Error ? error.message : String(error);
          record.state = 'FAILED';
        }
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
