import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { ariadPiAuthPath, resolveAriadPiModelRef } from './pi-runtime-config.js';
import { setupPiProviders } from './pi-provider-setup.js';
import { normalizeRoleModels, requireCompleteRoleModels } from './role-models.js';

/**
 * The configuration layer over Pi's own model configuration. Ariad keeps
 * no provider registry of its own: providers and models live in Pi's
 * models.json, credentials in Pi's auth store, and this module is the
 * single read/write surface the CLI navigation and the dashboard config
 * UI share. API keys enter only through local UI/CLI fields and are
 * stored by Pi; nothing here ever returns a stored key.
 */

export function piAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

export function globalPiModelsPath() {
  return process.env.ARIAD_PI_MODELS_PATH || join(piAgentDir(), 'models.json');
}

export function ariadInstallConfigPath() {
  return process.env.ARIAD_INSTALL_CONFIG_PATH || join(piAgentDir(), 'ariad-config.json');
}

export function readPiModelsConfig(path = globalPiModelsPath()) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`PI_MODELS_CONFIG_INVALID: ${path}: ${error.message}`);
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export function writePiModelsConfig(config, path = globalPiModelsPath()) {
  writeJsonFile(path, config);
}

function summarizeProvider(id, provider) {
  return {
    id,
    baseUrl: provider?.baseUrl ?? null,
    api: provider?.api ?? null,
    hasApiKey: Boolean(provider?.apiKey),
    models: (provider?.models ?? []).map(model => ({
      id: model.id,
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      cost: model.cost ?? null,
    })),
  };
}

export function upsertPiProvider(config, providerId, provider) {
  const providers = { ...(config?.providers ?? {}) };
  providers[providerId] = provider;
  return { ...(config ?? {}), providers };
}

export function removePiProvider(config, providerId) {
  const providers = { ...(config?.providers ?? {}) };
  const removed = providerId in providers;
  delete providers[providerId];
  return { config: { ...(config ?? {}), providers }, removed };
}

const PROVIDER_KEY_ENVS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  meta: 'META_API_KEY',
};

/**
 * Store an API key in Pi's auth.json as {type:'api_key', key}. The key is
 * write-only here: no function in this module ever returns it. Refuses to
 * overwrite an OAuth credential (a subscription login) unless forced -
 * clobbering one by pasting a key would be a nasty surprise.
 */
export function saveApiKeyCredential(authPath, providerId, key, { force = false } = {}) {
  if (!providerId || typeof providerId !== 'string') throw new Error('CONFIG_PROVIDER_ID_REQUIRED');
  if (!key || typeof key !== 'string' || !key.trim()) throw new Error('CONFIG_API_KEY_REQUIRED');
  let auth = {};
  if (existsSync(authPath)) {
    try { auth = JSON.parse(readFileSync(authPath, 'utf8')); }
    catch (error) { throw new Error(`PI_AUTH_INVALID: ${authPath}: ${error.message}`); }
  }
  const existing = auth[providerId];
  if (existing?.type === 'oauth' && !force) {
    throw new Error(`ARIAD_AUTH_OAUTH_EXISTS: ${providerId} already has an OAuth login; refusing to overwrite it with an API key`);
  }
  auth[providerId] = { type: 'api_key', key: key.trim() };
  writeJsonFile(authPath, auth);
  return { saved: true, providerId };
}

/** Probe an OpenAI-compatible endpoint the way a local server is used:
 * GET <base>/models. Never throws; reachability is data, not an error. */
export async function probeLocalEndpoint(baseUrl, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  const root = String(baseUrl ?? '').replace(/\/+$/, '');
  try {
    const response = await fetchImpl(`${root}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { baseUrl: root, reachable: false, error: `HTTP ${response.status}` };
    const body = await response.json().catch(() => null);
    const models = Array.isArray(body?.data) ? body.data.map(entry => entry?.id).filter(Boolean) : [];
    return { baseUrl: root, reachable: true, models };
  } catch (error) {
    return { baseUrl: root, reachable: false, error: String(error?.message ?? error) };
  }
}

export function createAriadConfigService({
  modelsPath = globalPiModelsPath(),
  authPath = ariadPiAuthPath(),
  installConfigPath = ariadInstallConfigPath(),
  runtimeFactory = null,
} = {}) {
  let runtimePromise = null;
  const runtime = () => {
    runtimePromise ??= runtimeFactory
      ? runtimeFactory({ authPath, modelsPath })
      : ModelRuntime.create({ authPath, modelsPath });
    return runtimePromise;
  };

  const customProviders = () => {
    const config = readPiModelsConfig(modelsPath);
    return Object.entries(config?.providers ?? {}).map(([id, provider]) => summarizeProvider(id, provider));
  };

  const roleDefaults = () => {
    if (!existsSync(installConfigPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(installConfigPath, 'utf8'));
      return parsed?.roleModels ?? null;
    } catch (error) {
      throw new Error(`ARIAD_INSTALL_CONFIG_INVALID: ${installConfigPath}: ${error.message}`);
    }
  };

  const resolveRoleRef = async ref => {
    const target = resolveAriadPiModelRef(ref);
    const model = (await runtime()).getModel(target.provider, target.model);
    if (!model) {
      return {
        ref, ok: false, provider: target.provider, model: target.model,
        reason: 'MODEL_NOT_FOUND_IN_PI_CATALOG_OR_MODELS_JSON',
      };
    }
    return {
      ref, ok: true, provider: target.provider, model: target.model,
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      cost: model.cost ?? null,
    };
  };

  const validateRoleModels = async roleModels => {
    let complete = true;
    let completenessError = null;
    try {
      requireCompleteRoleModels(normalizeRoleModels(roleModels ?? {}));
    } catch (error) {
      complete = false;
      completenessError = String(error?.message ?? error);
    }
    const roles = {};
    for (const [role, ref] of Object.entries(roleModels ?? {})) {
      roles[role] = await resolveRoleRef(ref).catch(error => ({
        ref, ok: false, reason: String(error?.message ?? error),
      }));
    }
    return { complete, completenessError, roles };
  };

  return {
    paths: { modelsPath, authPath, installConfigPath },
    customProviders,
    readiness: () => setupPiProviders({ authPath }),
    roleDefaults,
    resolveRoleRef,
    validateRoleModels,
    probeLocalEndpoint: (baseUrl, options) => probeLocalEndpoint(baseUrl, options),

    setRoleDefaults(roleModels) {
      const normalized = requireCompleteRoleModels(normalizeRoleModels(roleModels ?? {}));
      writeJsonFile(installConfigPath, { roleModels: normalized });
      return normalized;
    },

    upsertCustomProvider(providerId, provider) {
      if (!providerId || typeof providerId !== 'string') {
        throw new Error('CONFIG_PROVIDER_ID_REQUIRED');
      }
      if (!/^https?:\/\//.test(String(provider?.baseUrl ?? ''))) {
        throw new Error('CONFIG_PROVIDER_BASE_URL_REQUIRED: an HTTP(S) baseUrl is required');
      }
      const models = (provider.models ?? []).map(model => {
        if (!model?.id) throw new Error('CONFIG_PROVIDER_MODEL_ID_REQUIRED');
        return {
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
          ...(model.contextWindow != null ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxTokens != null ? { maxTokens: model.maxTokens } : {}),
          ...(model.cost != null ? { cost: model.cost } : {}),
          ...(model.reasoning != null ? { reasoning: model.reasoning } : {}),
          ...(model.input != null ? { input: model.input } : {}),
        };
      });
      const entry = {
        baseUrl: provider.baseUrl,
        api: provider.api ?? 'openai-completions',
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        models,
      };
      const current = readPiModelsConfig(modelsPath) ?? { providers: {} };
      writePiModelsConfig(upsertPiProvider(current, providerId, entry), modelsPath);
      return { saved: true, provider: summarizeProvider(providerId, entry) };
    },

    removeCustomProvider(providerId) {
      const current = readPiModelsConfig(modelsPath) ?? { providers: {} };
      const { config, removed } = removePiProvider(current, providerId);
      if (removed) writePiModelsConfig(config, modelsPath);
      return { removed, providerId };
    },

    configuredProviders() {
      const found = new Map();
      let auth = {};
      if (existsSync(authPath)) {
        try { auth = JSON.parse(readFileSync(authPath, 'utf8')); } catch { auth = {}; }
      }
      for (const providerId of Object.keys(auth ?? {})) {
        found.set(providerId, { id: providerId, source: 'pi-auth' });
      }
      for (const [providerId, envName] of Object.entries(PROVIDER_KEY_ENVS)) {
        if (process.env[envName] && !found.has(providerId)) {
          found.set(providerId, { id: providerId, source: `env:${envName}` });
        }
      }
      for (const provider of customProviders()) {
        if (!found.has(provider.id)) found.set(provider.id, { id: provider.id, source: 'models.json' });
      }
      return [...found.values()];
    },

    saveApiKey(providerId, key, options) {
      return saveApiKeyCredential(authPath, providerId, key, options);
    },

    async listProviderModels(providerId) {
      const models = (await runtime()).getModels(providerId) ?? [];
      const total = model => (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
      return models
        .map(model => ({
          id: model.id,
          contextWindow: model.contextWindow ?? null,
          maxTokens: model.maxTokens ?? null,
          cost: model.cost ?? null,
        }))
        .sort((a, b) => total(b) - total(a));
    },

    /** One tiny live completion to prove a ref actually answers. Opt-in:
     * it spends a real (minimal) API call, so callers ask first. */
    async testModelRef(ref) {
      const target = resolveAriadPiModelRef(ref);
      const rt = await runtime();
      const model = rt.getModel(target.provider, target.model);
      if (!model) return { ref, ok: false, reason: 'MODEL_NOT_FOUND_IN_PI_CATALOG_OR_MODELS_JSON' };
      try {
        const reply = await rt.completeSimple(model, {
          messages: [{ role: 'user', content: 'Reply with the single word: ok', timestamp: Date.now() }],
        }, { maxTokens: 16 });
        if (reply?.stopReason === 'error') {
          return { ref, ok: false, reason: String(reply.errorMessage ?? 'provider error') };
        }
        return { ref, ok: true };
      } catch (error) {
        return { ref, ok: false, reason: String(error?.message ?? error) };
      }
    },

    async snapshot() {
      return {
        paths: { modelsPath, authPath, installConfigPath },
        customProviders: customProviders(),
        readiness: setupPiProviders({ authPath }),
        roleDefaults: roleDefaults(),
      };
    },
  };
}
