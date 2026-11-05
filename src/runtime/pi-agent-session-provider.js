import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { buildStandaloneRolePrompt } from './role-run-prompt.js';
import { migrateLegacyPiAuth } from './pi-auth-migration.js';
import { registerAriadProjectTools } from './pi-project-tools.js';
import { managedBashCheckIntervalMs, registerManagedBashTools, sweepManagedBashOrphans } from './managed-bash.js';

import {
  piToolsForTask,
  buildAriadPiModelsConfig,
  ariadPiPaths,
  resolveAriadPiModelRef,
} from './pi-runtime-config.js';
import { globalPiModelsPath, readPiModelsConfig } from './config-service.js';

const RESULT_TOOL = 'ariad_role_result';
const DELIVERY_ROLES = new Set(['developer', 'test_engineer', 'tester', 'artist', 'reviewer', 'ux_reviewer']);
const REVIEWER_MUTATING_TOOLS = new Set(['edit', 'write', 'ariad_memory_write']);
export const ARIAD_DELIVERY_SYSTEM_PROMPT = 'You are an Ariad execution agent. The canonical task artifact in the user message is authoritative. Follow the active role protocol, obey runtime tool policy, use tools as needed, and finish by calling ariad_role_result exactly once.';
const DEFAULT_CODEX_QUOTA_FALLBACK = 'meta/muse-spark-1.2-contributor';

/** Only a confirmed account usage/quota exhaustion triggers provider failover. */
export function isCodexQuotaExhaustion(error) {
  const message = String(error?.message ?? error ?? '');
  return /usage limit has been reached|usage limit reached|quota (?:has been )?exceeded|insufficient_quota|you(?:'ve| have) (?:hit|reached) (?:your|the) (?:ChatGPT )?(?:usage|weekly|monthly) limit/i.test(message);
}

function codexQuotaFallbackSpec(spec) {
  if (!String(spec.context?.roleModelRef ?? '').startsWith('openai-codex/')) return null;
  const alternate = process.env.ARIAD_CODEX_QUOTA_FALLBACK || DEFAULT_CODEX_QUOTA_FALLBACK;
  if (!alternate || alternate === spec.context.roleModelRef) return null;
  resolveAriadPiModelRef(alternate);
  return {
    ...spec,
    sessionPolicy: 'fresh', // Never poison the primary model's persistent session.
    attemptId: String(spec.attemptId ?? spec.taskId) + ':quota-fallback',
    context: {
      ...spec.context,
      roleModelRef: alternate,
      roleModels: { ...(spec.context?.roleModels ?? {}), [spec.role]: alternate },
      sessionKey: null,
    },
  };
}


const ROLE_RESULT_OUTCOMES = Object.freeze({
  artist: ['PASS', 'NOT_PASS', 'NEEDS_CAPABILITY'],
  developer: ['PASS', 'NOT_PASS'],
  test_engineer: ['PASS', 'NOT_PASS'],
  tester: ['PASS', 'NOT_PASS'],
  reviewer: ['PASS', 'NOT_PASS'],
  ux_reviewer: ['PASS', 'NOT_PASS'],
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
  // Tool-issued anchors (ariad_anchor_lookup) carry the hash pin and VALID
  // status they were resolved with; the schema must accept that canonical
  // shape verbatim.
  fileHash: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const discoveredIssueSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  severity: Type.Optional(Type.Union([
    Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('critical'),
  ])),
  blocking: Type.Optional(Type.Boolean()),
  affectedComponent: Type.Optional(Type.String()),
  affectedInterface: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Array(Type.Any())),
  dedupeKey: Type.Optional(Type.String()),
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
      discoveredIssues: Type.Optional(Type.Array(discoveredIssueSchema)),
      interfaceRealizations: Type.Array(Type.Object({
        interfaceId: Type.String({ minLength: 1 }),
        anchors: Type.Array(anchorSchema),
      }, { additionalProperties: false })),
    }));
  } else if (role === 'test_engineer') {
    result = Type.Object({
      testPlan: Type.Object({
        scope: Type.Array(Type.String()),
        excluded: Type.Array(Type.String()),
        testCases: Type.Array(Type.Object({
          id: Type.String({ minLength: 1 }),
          entry: Type.String({ minLength: 1 }),
          command: Type.String({ minLength: 1 }),
          covers: Type.Array(Type.String({ pattern: '^AC[1-9][0-9]*$' })),
          executionScope: Type.Array(Type.String()),
        }, { additionalProperties: true })),
        testRepairs: Type.Array(Type.Any()),
      }, { additionalProperties: true }),
      discoveredIssues: Type.Optional(Type.Array(discoveredIssueSchema)),
    }, { additionalProperties: true });
  } else if (role === 'tester') {
    result = Type.Object({
      discoveredIssues: Type.Optional(Type.Array(discoveredIssueSchema)),
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
      interfaceVerifications: Type.Array(Type.Object({
        interfaceId: Type.String({ minLength: 1 }),
        evidence: Type.Array(Type.Any()),
        anchors: Type.Optional(Type.Array(anchorSchema)),
      }, { additionalProperties: false })),
    }, { additionalProperties: true });
  } else if (role === 'reviewer') {
    result = Type.Optional(openResult({
      discoveredIssues: Type.Optional(Type.Array(discoveredIssueSchema)),
      interfaceReviews: Type.Array(Type.Object({
        interfaceId: Type.String({ minLength: 1 }),
        status: Type.Literal('APPROVED'),
        reason: Type.String({ minLength: 1 }),
      }, { additionalProperties: false })),
    }));
  } else if (role === 'tech_lead') {
    const stage = Type.Union([Type.Literal('RUN'), Type.Literal('SKIP')]);
    const route = Type.Object({
      requestType: Type.Union([
        Type.Literal('PLAN'), Type.Literal('REPLAN'),
        Type.Literal('TASK_SPLIT'), Type.Literal('TASK_REPAIR'),
        Type.Literal('INTERFACE_REPAIR'),
      ]),
      reason: Type.String({ minLength: 1 }),
      scope: Type.Object({
        featureRoots: Type.Array(Type.String({ minLength: 1 })),
        milestoneRoots: Type.Array(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }),
      stages: Type.Object({ feature: stage, milestone: stage, interface: stage }, { additionalProperties: false }),
      constraints: Type.Optional(Type.Object({
        preserveCompletedTasks: Type.Optional(Type.Boolean()),
        preserveProductSemantics: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false })),
    }, { additionalProperties: false });
    result = Type.Optional(Type.Union([route, openResult()]));
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

  if (role === 'tech_lead') {
    return Type.Object({ outcome: Type.Union([Type.Literal('PLANNED'), Type.Literal('REPLANNED')]), ...commonFields, result: Type.Optional(openResult()) }, { additionalProperties: false });
  }
  return Type.Object({
    outcome,
    ...commonFields,
    result,
  }, { additionalProperties: false });
}

// The schema registered as the tool's parameters IS the schema that
// validates the submission (piRoleResultToolSchema). There is deliberately
// no second, divergent "declared" schema: on 2026-11-01 a tester session
// burned ~1000 submissions because the registered schema marked the
// tester's result.criteria Optional while the validation schema required
// it - the model followed the contract it was shown and was rejected by a
// hidden one. Per-role requiredness also replaces the former blanket rule
// that every delivery result carry all three interface seal slots: a
// role's result must carry the slots its own schema names (developer:
// interfaceRealizations; tester: criteria + interfaceVerifications;
// reviewer: interfaceReviews). Downstream seal validation tolerates the
// absence of slots a role does not own.
export function piDeclaredRoleResultToolSchema(role) {
  return piRoleResultToolSchema(role);
}

export const MAX_CONSECUTIVE_INVALID_RESULT_SUBMISSIONS = 5;

// Counts consecutive schema-invalid ariad_role_result submissions within
// one session. A model that cannot repair its submission from the
// validation detail would otherwise retry forever (observed: ~1000
// attempts); when the count reaches the limit the tool terminates the
// session without an accepted result, and the attempt then fails through
// the normal missing-result path instead of looping.
export function createResultSubmissionGuard(role, limit = MAX_CONSECUTIVE_INVALID_RESULT_SUBMISSIONS) {
  const schema = piRoleResultToolSchema(role);
  let invalidCount = 0;
  return {
    validate(params) {
      if (Check(schema, params)) {
        invalidCount = 0;
        return { ok: true, invalidCount };
      }
      invalidCount += 1;
      const detail = [...Errors(schema, params)]
        .slice(0, 8)
        .map(error => `${error.path || '/'}: ${error.message}`)
        .join('; ');
      return { ok: false, invalidCount, detail, tripped: invalidCount >= limit };
    },
  };
}

const BASH_DEVICE_ALLOWLIST = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);
const REVIEWER_GIT_VERBS = new Set(['status', 'diff', 'add', 'commit', 'push', 'log', 'show']);

function bashTokens(command) {
  return (String(command).match(/"[^"]*"|'[^']*'|[^\s;|&<>()]+/g) ?? [])
    .map(token => token.replace(/^["']|["']$/g, ''));
}

/**
 * Deterministic guardrail (not a sandbox): bash sessions run with the
 * project workspace as cwd, and commands must stay inside it. Absolute
 * paths outside the workspace are rejected — the failure this prevents
 * is a role scanning or reading the host (`find /`, `cat /etc/...`).
 * An absolute path to an executable FILE is a program invocation (e.g.
 * a Godot binary) and is allowed; its arguments are still checked.
 */
export function bashConfinementViolation(command, workspace) {
  if (typeof command !== 'string' || typeof workspace !== 'string' || !workspace.trim()) return null;
  const root = workspace.replace(/\/+$/, '');
  if (/(^|[;&|]\s*)cd\s+(?:\.\.(?:\/|\s|$)|\.\.$)/.test(command)) {
    return 'cd .. leaves the workspace root';
  }
  for (const rawToken of bashTokens(command)) {
    let token = rawToken;
    const eq = token.lastIndexOf('=');
    if (eq > 0) token = token.slice(eq + 1);
    token = token.replace(/[,;]+$/, '');
    if (token === '~' || token.startsWith('~/') || token.startsWith('$HOME')) {
      return `home-relative path escapes the workspace: ${rawToken}`;
    }
    if (!token.startsWith('/')) continue;
    if (token === '/') return 'filesystem root used as a path argument';
    if (token === root || token.startsWith(`${root}/`)) continue;
    if (BASH_DEVICE_ALLOWLIST.has(token) || token.startsWith('/dev/fd/')) continue;
    try {
      const stat = statSync(token);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) continue;
    } catch {}
    return `absolute path outside the workspace: ${token}`;
  }
  return null;
}

export function deliveryToolPolicy(role, toolName, context = {}) {
  // Ariad state protection (2026-11-03 incident): a role session used the
  // built-in edit/write tools on .ariad/state2.db as a binary file and
  // zeroed the project's planning store, then reported the damage as a
  // successful repair. Built-in file tools must never read or write the
  // project's SQLite stores (any *.db / *.db-wal / *.db-shm /
  // *.db-journal under .ariad/), and the append-only audit logs
  // (debug-ops.jsonl, control-actions.jsonl) are write-protected for
  // role sessions. Reads of the audit logs stay allowed.
  if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
    const target = context.input?.path ?? context.input?.file_path ?? context.input?.filePath;
    if (typeof target === 'string' && target && context.workspace) {
      const abs = resolve(context.workspace, target);
      const rel = relative(context.workspace, abs).split('\\').join('/');
      const base = rel.split('/').pop() ?? '';
      const inAriad = rel === '.ariad' || rel.startsWith('.ariad/');
      const isDbFile = /\.db(?:-wal|-shm|-journal)?$/i.test(base);
      if (inAriad && isDbFile) {
        return { block: true, reason: `PROTECTED_ARIAD_STATE: ${toolName} on ${rel} is denied - Ariad state databases under .ariad/ are never file-tool targets (a direct binary edit corrupted a project store on 2026-11-03). Use the Ariad tools (ariad_tree_patch for the spec tree) instead.` };
      }
      const isAuditLog = base === 'debug-ops.jsonl' || base === 'control-actions.jsonl';
      if (inAriad && isAuditLog && toolName !== 'read') {
        return { block: true, reason: `PROTECTED_ARIAD_AUDIT: ${toolName} on ${rel} is denied - .ariad/${base} is an append-only audit log written only by the Ariad system, never by a role session.` };
      }
    }
  }
  if ((role === 'reviewer' || role === 'ux_reviewer') && REVIEWER_MUTATING_TOOLS.has(toolName)) {
    return { block: true, reason: `Ariad reviewer runtime policy denies mutating tool: ${toolName}` };
  }
  if (toolName === 'bash') {
    const command = context.input?.command;
    if (role === 'reviewer' || role === 'ux_reviewer') {
      // Reviewer bash exists for git finalization only (see the reviewer
      // protocol): every command segment must be an allowed git call.
      if (typeof command !== 'string' || !command.trim()) {
        return { block: true, reason: 'Ariad reviewer runtime policy: bash is git-only and needs a command to evaluate' };
      }
      for (const segment of command.split(/[;|&\n]+/)) {
        const tokens = bashTokens(segment);
        if (tokens.length === 0) continue;
        if (tokens[0] !== 'git' || !REVIEWER_GIT_VERBS.has(tokens[1] ?? '')) {
          return { block: true, reason: `Ariad reviewer runtime policy: bash is git-only (status/diff/add/commit/push/log/show); denied segment: ${segment.trim().slice(0, 80)}` };
        }
      }
    }
    const violation = bashConfinementViolation(command, context.workspace);
    if (violation) {
      return { block: true, reason: `Ariad bash confinement: ${violation}. Stay inside the project workspace; use relative paths, ariad_code_search, or ariad_anchor_lookup for code lookup.` };
    }
  }
  if (role === 'tech_lead' && (toolName === 'edit' || toolName === 'write')) {
    // Existing planner JSON is changed only through ariad_planner_patch:
    // a degenerate model generation must never land verbatim in a shared
    // planning artifact (2026-10-30 batch-52). New planner files may still
    // be created with write; once a file exists, edit is always denied and
    // write-overwrite is denied, so the patch tool is the only mutation
    // path (the Tech Lead has no bash or delete tool to bypass with).
    const target = context.input?.path ?? context.input?.file_path ?? context.input?.filePath;
    if (typeof target === 'string' && target && context.workspace) {
      const abs = resolve(context.workspace, target);
      const rel = relative(join(context.workspace, '.ariad', 'artifacts', 'planner'), abs);
      if (!rel.startsWith('..') && rel.endsWith('.json')) {
        const segments = rel.split('/');
        const guarded = segments[0] === 'milestones' || segments[0] === 'logical'
          || (segments[0] === 'interfaces' && (segments[1] === 'features' || segments[1] === 'milestones'));
        if (guarded && (toolName === 'edit' || existsSync(abs))) {
          return { block: true, reason: `Ariad planner policy: existing planner artifacts change only through ariad_planner_patch (structured ops, validated before write); direct ${toolName} on planner/${rel} is denied. Create new planner files with write, then patch them.` };
        }
      }
    }
  }
  return null;
}

/** Pi model discovery is per workspace, shared by concurrent role sessions.
 * Remote-provider runs must never erase local llama.cpp definitions. */
export function ensureLocalPiModelsConfig(path, roleModels) {
  const generated = buildAriadPiModelsConfig(roleModels);
  const local = generated.providers?.llamacpp;
  if (!local) return false;
  let current = { providers: {} };
  if (existsSync(path)) current = JSON.parse(readFileSync(path, 'utf8'));
  // The user's global Pi configuration (maintained by the config UI /
  // CLI navigation layer) flows into every workspace: its providers are
  // the base, the workspace file's own entries override, and generated
  // llamacpp definitions fill the remaining gaps.
  const globalPath = globalPiModelsPath();
  if (resolve(path) !== resolve(globalPath)) {
    const globalConfig = readPiModelsConfig(globalPath);
    if (globalConfig?.providers) {
      current = {
        ...globalConfig,
        ...current,
        providers: { ...(globalConfig.providers ?? {}), ...(current.providers ?? {}) },
      };
    }
  }
  const prior = current.providers?.llamacpp;
  const models = new Map((prior?.models ?? []).map(model => [model.id, model]));
  for (const model of local.models) models.set(model.id, model);
  const next = {
    ...current,
    providers: {
      ...(current.providers ?? {}),
      llamacpp: { ...prior, ...local, models: [...models.values()] },
    },
  };
  const content = JSON.stringify(next, null, 2) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
  return true;
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

// Owner decision 2026-11-04: the persistent-session roles that stay
// persistent (PM, project debugger) must compact before a run once their
// context grows past 70% of the model window, so they can never reach
// the provider's hard context limit the way the pre-2026-11-04 persistent
// TL session did (TL now runs fresh per task instead). The threshold is
// overridable via ARIAD_SESSION_COMPACT_RATIO (legacy alias:
// ARIAD_PM_COMPACT_RATIO) for tests/operations.
export const SESSION_COMPACT_RATIO = 0.7;
export const PM_SESSION_COMPACT_RATIO = SESSION_COMPACT_RATIO;
const COMPACT_GUARDED_ROLES = new Set(['pm', 'project_debugger']);

export function sessionCompactRatio(env = process.env) {
  const parsed = Number(env?.ARIAD_SESSION_COMPACT_RATIO ?? env?.ARIAD_PM_COMPACT_RATIO);
  if (Number.isFinite(parsed) && parsed > 0.05 && parsed < 0.99) return parsed;
  return SESSION_COMPACT_RATIO;
}
export const pmSessionCompactRatio = sessionCompactRatio;

export async function maybeCompactPersistentSessionBeforeRun(session, spec, { ratio = sessionCompactRatio() } = {}) {
  if (!COMPACT_GUARDED_ROLES.has(spec?.role) || spec?.sessionPolicy !== 'persistent') return false;
  let usage = null;
  try { usage = session?.getContextUsage?.(); } catch { usage = null; }
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return false;
  if (usage.tokens <= ratio * usage.contextWindow) return false;
  try {
    await session.compact();
    console.log(`[pi-session] ${spec.role} persistent session compacted before run (project=${spec.projectId ?? '?'} task=${spec.taskId ?? '?'} context=${usage.tokens}/${usage.contextWindow})`);
    return true;
  } catch (err) {
    console.warn(`[pi-session] ${spec.role} session compaction failed (project=${spec.projectId ?? '?'} task=${spec.taskId ?? '?'}): ${err?.message ?? err}`);
    return false;
  }
}
export const maybeCompactPmSessionBeforeRun = maybeCompactPersistentSessionBeforeRun;

// The Pi SDK ships a built-in MCP extension, but the package exports do not
// expose the built-in extension registry, so Ariad loads the extension file
// from the installed package on disk. If the SDK layout ever changes, MCP
// support degrades to "no MCP tools" instead of breaking session creation.
export function bundledPiMcpExtensionPath() {
  try {
    const sdkMain = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const candidate = join(dirname(dirname(sdkMain)), 'dist', 'extensions', 'mcp', 'index.js');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// Per-project MCP servers live in the project's Pi agent dir (mcp.json,
// standard mcpServers shape). Ariad registers them with the SDK's MCP
// extension for the roles that may drive external tools; the extension owns
// the protocol, the connections and the tool declarations.
export function readProjectMcpServers(agentDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'));
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers).filter(([, config]) => config && typeof config === 'object');
  } catch {
    return [];
  }
}

const MCP_ROLES = new Set(['artist']);

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
    ensureLocalPiModelsConfig(paths.modelsPath, roleModels);
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
  const resultSubmissionGuard = createResultSubmissionGuard(spec.role);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const mcpExtensionPath = bundledPiMcpExtensionPath();
  const mcpServers = MCP_ROLES.has(spec.role) ? readProjectMcpServers(paths.root) : [];
  let managedBash = null;
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: paths.root,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(mcpExtensionPath ? { additionalExtensionPaths: [mcpExtensionPath] } : {}),
    ...(DELIVERY_ROLES.has(spec.role) ? {
      systemPromptOverride: () => ARIAD_DELIVERY_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    } : {}),
    extensionFactories: [(pi) => {
      registerAriadProjectTools(pi, {
        workspace,
        codeIntelligence: spec.codeIntelligence ?? null,
        projectStoreFile: spec.projectStoreFile ?? null,
        reportIssue: spec.reportIssue ?? null,
        insertTriagedFixTask: spec.insertTriagedFixTask ?? null,
        taskContext: { taskId: spec.taskId ?? null, role: spec.role ?? null, projectId: spec.projectId ?? null },
      });
      // Supervised bash (managed-bash.js) shadows the built-in bash in the
      // SDK tool registry for every session; the role allowlist still
      // decides which sessions actually see it.
      managedBash = registerManagedBashTools(pi, { workspace, checkIntervalMs: managedBashCheckIntervalMs() });
      for (const [name, config] of mcpServers) {
        try {
          pi.registerMcpServer(name, config);
        } catch {
          // A malformed server entry must never break session creation.
        }
      }
      if (DELIVERY_ROLES.has(spec.role) || spec.role === 'tech_lead') {
        pi.on('tool_call', event => deliveryToolPolicy(spec.role, event.toolName, { input: event?.input ?? event?.args ?? {}, workspace }) ?? undefined);
      }
      pi.registerTool({
        name: RESULT_TOOL,
        label: 'Ariad role result',
        description: 'Submit the authoritative structured result for this Ariad role. Arguments are strictly validated. Use only the outcome values and result shape allowed by this tool schema. This must be the final action.',
        parameters: piDeclaredRoleResultToolSchema(spec.role),
        async execute(_toolCallId, params) {
          const verdict = resultSubmissionGuard.validate(params);
          if (!verdict.ok) {
            if (verdict.tripped) {
              return {
                content: [{ type: 'text', text: `ARIAD_ROLE_RESULT_CIRCUIT_BREAKER: ${verdict.invalidCount} consecutive schema-invalid submissions of ${RESULT_TOOL} in this session; the session is terminated without an accepted result. Last validation detail: role=${spec.role}; ${verdict.detail}` }],
                details: { accepted: false, circuitBreaker: true, invalidSubmissions: verdict.invalidCount },
                terminate: true,
              };
            }
            throw new Error(`ARIAD_ROLE_RESULT_SCHEMA_INVALID: role=${spec.role}; ${verdict.detail}`);
          }
          if (spec.role === 'test_engineer' && params.outcome === 'PASS') {
            const required = spec.context?.task?.acceptanceCriterionIds ?? [];
            const cases = params.result?.testPlan?.testCases ?? [];
            const invalid = cases.flatMap(c => (c.covers ?? []).filter(id => !required.includes(id)));
            const missing = required.filter(id => !cases.some(c => c.covers?.includes(id)));
            if (!cases.length || invalid.length || missing.length) throw new Error(
              'ARIAD_TEST_PLAN_COVERAGE_INVALID: covers must reference exact acceptanceCriterionIds. ' +
              'Allowed: ' + JSON.stringify(required) + '; invalid: ' + JSON.stringify(invalid) + '; missing: ' + JSON.stringify(missing)
            );
          }
          if (spec.role === 'pm' && params.outcome === 'NEEDS_HUMAN') {
            // Escalation whitelist: a human may only be summoned over the
            // requirements themselves, and only with concrete questions.
            const questions = params.result?.questions;
            if (!Array.isArray(questions) || !questions.some(q => typeof q === 'string' && q.trim())) {
              throw new Error('ARIAD_PM_HUMAN_ESCALATION_INVALID: NEEDS_HUMAN is reserved for problems with the requirements/goal themselves and requires concrete questions in result.questions. If the plan needs work, submit PLAN_REVISION_REQUIRED instead.');
            }
          }
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

  const roleTools = piToolsForTask({ role: spec.role, taskKind: spec.taskKind });
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: paths.root,
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    // With MCP servers registered for this role, the session cannot use the
    // SDK's exact-name allowlist: MCP tool names only exist once the server
    // connects, and the allowlist would filter them out of the tool registry
    // for good. Instead the role's tools become the initial active set, and
    // the MCP tools the project's own mcp.json configured activate as they
    // register with the session.
    ...(mcpServers.length ? {} : { tools: roleTools }),
  });
  if (mcpServers.length) session.setActiveToolsByName(roleTools);
  await session.bindExtensions({ mode: 'json' });
  // Supervised bash dies with its session: anything the session left
  // running is terminated when the provider disposes the session.
  const disposeSession = session.dispose?.bind(session);
  session.dispose = () => { try { managedBash?.dispose(); } catch { /* noop */ } return disposeSession?.(); };
  // A resumed persistent session always runs this run's configured
  // model, whatever model its stored transcript was created with.
  if (session.model?.provider !== model.provider || session.model?.id !== model.id) {
    await session.setModel(model, { persist: false });
  }
  await maybeCompactPersistentSessionBeforeRun(session, spec);

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
    // Reap supervised-bash orphans left behind by a previous daemon
    // generation (and, on this startup sweep only, the legacy e2e orphans
    // that predate the birthmark system).
    try {
      const reaped = sweepManagedBashOrphans({ includeLegacyE2e: true, throttleMs: 0 });
      if (reaped.length > 0) console.log('[managed-bash] startup sweep reaped ' + reaped.length + ' orphaned process(es): ' + reaped.map((r) => r.pid + '(' + r.reason + ')').join(', '));
    } catch { /* the sweeper must never break provider construction */ }
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
    try { sweepManagedBashOrphans({}); } catch { /* throttled internally; best effort */ }

    const buildRunPrompt = (runSpec, { quotaRetry = false } = {}) => [
      buildStandaloneRolePrompt(runSpec.context ?? {}, runSpec.prompt ?? ''),
      '',
      'ARIAD RUNTIME CONTEXT',
      JSON.stringify({
        projectId: runSpec.projectId,
        taskId: runSpec.taskId,
        role: runSpec.role,
        attemptId: runSpec.attemptId ?? null,
        sessionPolicy: runSpec.sessionPolicy ?? 'fresh',
      }),
      '',
      ...(quotaRetry ? [
        'A previous attempt at this same task was cut off when the primary model exhausted its usage quota. The workspace may contain partial work from that attempt: assess the current state on its merits, do not assume it is correct or complete, and complete the assigned role work in full.',
        '',
      ] : []),
      `When the assigned role work is actually complete, call ${RESULT_TOOL} exactly once. Do not finish with ordinary prose.`,
    ].join('\n');
    const prompt = buildRunPrompt(spec);

    const checkTerminalResult = run => {
      const result = run.getTerminalResult?.() ?? null;
      if (result) return result;
      const last = Array.isArray(run.session?.messages) ? run.session.messages.at(-1) : null;
      if (last?.role === 'assistant' && last?.stopReason === 'error' && last?.errorMessage) {
        throw new Error(`PI_PROVIDER_ERROR: ${last.errorMessage}`);
      }
      throw new Error('ARIAD_ROLE_RESULT_MISSING: Pi session ended without terminal result tool');
    };

    record.promise = (async () => {
      try {
        const run = await this.createRunSession(spec);
        record.session = run.session;
        let result;
        try {
          await run.session.prompt(prompt);
          try {
            result = checkTerminalResult(run);
          } catch (error) {
            if (!String(error?.message ?? '').startsWith('ARIAD_ROLE_RESULT_MISSING') || record.state === 'CANCELLED') throw error;
            // The session ended without submitting. The work may be fully
            // done in the workspace with only the mandatory result-tool
            // call missing — the provider owns this seam (the supervisor
            // only ever sees run states), so the SAME session is prompted
            // once to submit its completed result before the attempt is
            // failed. The submission lands through the same tool and the
            // same validation as an on-time one.
            await run.session.prompt('You ended your turn without submitting your role result. If the assigned role work is complete, submit it now by calling ' + RESULT_TOOL + ' exactly once with the full structured result; do not redo the work and do not reply with prose instead. If the work is not actually complete, complete it first and then submit.');
            result = checkTerminalResult(run);
            result = {
              ...result,
              keyPoints: [
                ...(result.keyPoints ?? []),
                'ARIAD_RESULT_RECOVERED: session submitted after a same-session resume prompt',
              ],
            };
          }
        } catch (error) {
          const fallbackSpec = isCodexQuotaExhaustion(error) ? codexQuotaFallbackSpec(spec) : null;
          if (!fallbackSpec || record.state === 'CANCELLED') throw error;
          // Quota failover NEVER transplants a second model into this
          // session's transcript. The inheriting model, handed a long
          // foreign transcript plus a terse "continue" nudge, rushes a
          // bare result and drops the role's structured payload (E2E
          // evidence: every seal failure came from a switched session;
          // uninterrupted sessions on any model sealed cleanly). Run
          // the role again in a FRESH session on the fallback model,
          // from the canonical task artifact, as the fallback spec
          // describes. One failover per attempt: if the fresh session
          // also fails, the attempt fails.
          try { run.session?.dispose?.(); } catch {}
          const fallbackRun = await this.createRunSession(fallbackSpec);
          record.session = fallbackRun.session;
          if (record.state === 'CANCELLED') throw error;
          await fallbackRun.session.prompt(buildRunPrompt(fallbackSpec, { quotaRetry: true }));
          result = checkTerminalResult(fallbackRun);
          result = {
            ...result,
            keyPoints: [
              ...(result.keyPoints ?? []),
              `ARIAD_MODEL_QUOTA_FALLBACK: ${spec.context.roleModelRef} -> ${fallbackSpec.context.roleModelRef} (fresh session)`,
            ],
          };
        }
        if (record.state === 'CANCELLED') return;
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
