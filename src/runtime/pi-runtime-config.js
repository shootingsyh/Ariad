import { homedir } from 'node:os';
import { join } from 'node:path';

export const ARIAD_PI_DEFAULT_TOOLS = Object.freeze([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
]);

export function resolveAriadPiModelRef(modelRef) {
  const value = String(modelRef ?? '').trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid Ariad model ref: ${modelRef}`);
  }
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);

  if (provider === 'openai') {
    return {
      ariadRef: value,
      provider: 'openai',
      model,
      auth: 'OPENAI_API_KEY-or-pi-auth',
    };
  }
  if (provider === 'openai-codex') {
    return {
      ariadRef: value,
      provider: 'openai-codex',
      model,
      auth: 'subscription-or-pi-auth',
    };
  }
  if (provider === 'meta') {
    return {
      ariadRef: value,
      provider: 'meta',
      model,
      auth: 'META_API_KEY-or-pi-auth',
    };
  }
  if (provider === 'llamacpp') {
    return {
      ariadRef: value,
      provider: 'llamacpp',
      model,
      auth: 'none',
    };
  }

  // Every other provider delegates to Pi's own catalog and models.json:
  // Ariad keeps no provider whitelist. Whether the provider and model
  // actually exist (and whether credentials resolve) is decided by Pi's
  // ModelRuntime at session start - or earlier by the configuration
  // layer's validation - not by a hardcoded list here.
  return {
    ariadRef: value,
    provider,
    model,
    auth: 'pi-auth-or-environment',
  };
}

export const ARIAD_PI_DELIVERY_TOOLS = Object.freeze([
  ...ARIAD_PI_DEFAULT_TOOLS,
  'ariad_code_search', 'ariad_interface_search', 'ariad_interface_contract', 'ariad_anchor_lookup',
  'ariad_document_symbols', 'ariad_definition', 'ariad_references', 'ariad_workspace_symbols', 'ariad_call_graph',
  'ariad_memory_search', 'ariad_memory_write',
  'ariad_session_history', 'ariad_report_issue', 'ariad_role_result',
]);

// Ad-hoc analysis remains declaration-level read-only. Delivery roles deliberately
// share one declaration set so Dev -> Test -> Review has a stable provider prefix;
// runtime policy blocks mutating tools for Reviewer.
export const ARIAD_PI_REVIEW_TOOLS = Object.freeze([
  'read', 'grep', 'find', 'ls',
  'ariad_code_search', 'ariad_interface_search', 'ariad_interface_contract', 'ariad_anchor_lookup',
  'ariad_document_symbols', 'ariad_definition', 'ariad_references', 'ariad_workspace_symbols', 'ariad_call_graph',
  'ariad_memory_search', 'ariad_session_history', 'ariad_role_result',
]);

// Read-only project tools shared by every non-executing tier: code and
// interface inspection plus memory/session recall. No shell, no mutation.
const ARIAD_PI_READONLY_PROJECT_TOOLS = Object.freeze([
  'ariad_code_search', 'ariad_interface_search', 'ariad_interface_contract', 'ariad_anchor_lookup',
  'ariad_document_symbols', 'ariad_definition', 'ariad_references', 'ariad_workspace_symbols', 'ariad_call_graph',
  'ariad_memory_search', 'ariad_session_history', 'ariad_role_result',
]);

// Planning read tier: critics, plan validators, PM, debugger and seal
// checker sessions judge artifacts and code; they never execute or edit.
// (The Critic session that ran `find /` across the host had been handed
// the full delivery set, bash included.)
export const ARIAD_PI_PLANNING_READ_TOOLS = Object.freeze([
  'read', 'grep', 'find', 'ls',
  ...ARIAD_PI_READONLY_PROJECT_TOOLS,
]);

// Planning write tier: the Tech Lead authors planning artifacts, so it
// keeps edit/write for new files and non-artifact content, plus the
// structured ariad_planner_patch tool for existing planner JSON (runtime
// policy denies direct edit/write there) — but no bash: planning never
// runs commands.
export const ARIAD_PI_PLANNING_WRITE_TOOLS = Object.freeze([
  'read', 'edit', 'write', 'grep', 'find', 'ls',
  'ariad_planner_patch',
  'ariad_tree_patch',
  ...ARIAD_PI_READONLY_PROJECT_TOOLS,
]);

const PI_EXECUTION_ROLES = Object.freeze(['developer', 'test_engineer', 'tester', 'artist']);
const PI_PLANNING_READ_ROLES = Object.freeze(['tech_lead_critic', 'plan_validator', 'pm', 'project_debugger', 'interface_seal']);

export function piToolsForTask({ role, taskKind } = {}) {
  if (taskKind === 'ADHOC_ANALYSIS') return [...ARIAD_PI_REVIEW_TOOLS];
  if (PI_EXECUTION_ROLES.includes(role)) return [...ARIAD_PI_DELIVERY_TOOLS];
  // Reviewer keeps the shared delivery declaration set (stable provider
  // prefix across Dev -> Test -> Review); runtime tool policy blocks its
  // mutating tools AND bash, so the declaration is not the capability.
  if (role === 'reviewer' || role === 'ux_reviewer') return [...ARIAD_PI_DELIVERY_TOOLS];
  if (role === 'tech_lead') return [...ARIAD_PI_PLANNING_WRITE_TOOLS];
  if (PI_PLANNING_READ_ROLES.includes(role)) return [...ARIAD_PI_PLANNING_READ_TOOLS];
  // Least privilege by default: an unrecognized session role gets the
  // read-only planning tier, never the full delivery set.
  return [...ARIAD_PI_PLANNING_READ_TOOLS];
}

export function piToolsForRole(_role) {
  // Keep the same general-purpose coding-agent capability boundary that Ariad
  // historically delegated to OpenClaw. Role semantics remain in Ariad prompts
  // and state transitions; Pi owns the mechanics of executing one role session.
  return [...ARIAD_PI_DEFAULT_TOOLS];
}

export function buildAriadPiModelsConfig(roleModels = {}, {
  llamaCppBaseUrl = process.env.ARIAD_LLAMACPP_BASE_URL || 'http://127.0.0.1:18080/v1',
} = {}) {
  const localModels = [...new Set(
    Object.values(roleModels)
      .map(value => String(value ?? '').trim())
      .filter(value => value.startsWith('llamacpp/'))
      .map(value => value.slice('llamacpp/'.length))
      .filter(Boolean),
  )].sort();

  if (localModels.length === 0) return { providers: {} };

  return {
    providers: {
      llamacpp: {
        baseUrl: llamaCppBaseUrl,
        api: 'openai-completions',
        apiKey: 'not-needed',
        models: localModels.map(id => ({
          id,
          name: id,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 16384,
        })),
      },
    },
  };
}

export function ariadPiAuthPath() {
  // Follow Pi's agent dir like every other config path does: a relocated
  // PI_CODING_AGENT_DIR must move the auth store too, or keys saved here
  // land where Pi never looks.
  return process.env.ARIAD_PI_AUTH_PATH
    || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'auth.json');
}

export function ariadPiPaths(workspace) {
  const root = join(workspace, '.ariad', 'pi');
  const authPath = ariadPiAuthPath();
  return {
    root,
    authPath,
    modelsPath: join(root, 'models.json'),
    sessionsDir: join(root, 'sessions'),
  };
}

export function buildAriadPiSessionConfig({
  workspace,
  role,
  modelRef,
  roleModels = {},
  sessionPolicy = 'fresh',
  sessionKey = null,
} = {}) {
  if (!workspace) throw new Error('Pi role runtime requires workspace');
  if (!role) throw new Error('Pi role runtime requires role');
  if (!modelRef) throw new Error('Pi role runtime requires explicit modelRef');

  const model = resolveAriadPiModelRef(modelRef);
  const paths = ariadPiPaths(workspace);

  return {
    cwd: workspace,
    role,
    model,
    tools: piToolsForRole(role),
    sessionPolicy,
    sessionKey: sessionPolicy === 'persistent' ? sessionKey : null,
    paths,
    modelsConfig: buildAriadPiModelsConfig(roleModels),
  };
}

export function createAriadPiTerminalTool({
  name,
  label = name,
  description,
  parameters,
  submit,
}) {
  if (!name || !parameters || typeof submit !== 'function') {
    throw new Error('Pi terminal result tool requires name, parameters, and submit');
  }
  return {
    name,
    label,
    description: description ?? 'Submit the authoritative Ariad role result. This must be the final action.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const details = await submit(params);
      return {
        content: [{
          type: 'text',
          text: 'Ariad role result accepted and sealed.',
        }],
        details,
        terminate: true,
      };
    },
  };
}

export const ARIAD_PI_SPECIAL_NEEDS = Object.freeze({
  headlessSession: 'createAgentSession',
  workspaceTools: [...ARIAD_PI_DEFAULT_TOOLS],
  persistentSessions: 'SessionManager',
  cancellation: 'AgentSession.abort',
  terminalStructuredResult: 'custom ToolDefinition result with terminate=true',
  hostedProviders: ['openai', 'openai-codex', 'meta'],
  localProvider: 'generated llamacpp OpenAI-compatible provider',
  providerFallback: false,
});
