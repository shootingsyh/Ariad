/**
 * Bootstrap ignition for the guided configuration assistant.
 *
 * Ignition = finding ANY model that actually answers, so a model can
 * guide the rest of configuration. The ladder, in order:
 *   1. existing access (stored Pi credentials, env keys, custom
 *      providers) - cheapest listed model per provider;
 *   2. a reachable local OpenAI-compatible endpoint (registered as the
 *      'local' custom provider, then tested like everything else);
 *   3. free-cloud routes (Gemini free tier) - listed as next actions
 *      only: they need a key the user must fetch, and a key NEVER
 *      travels through a model, so ignition cannot do this step alone.
 *
 * Every candidate is verified with a real minimal completion before it
 * counts as ignited - a candidate that cannot answer just moves the
 * ladder down. Total ignition failure is a normal, structured outcome
 * (not an exception): the report says what was tried, why each rung
 * failed, and points at the model-free paths (CLI wizard / dashboard
 * config page), which never needed a model in the first place. Ignition
 * is a convenience, never a prerequisite; it can be retried any time a
 * model becomes available.
 */

export const FREE_CLOUD_HINTS = Object.freeze([
  {
    provider: 'google',
    label: 'Google Gemini (free tier)',
    how: 'aistudio.google.com/apikey - sign in with a Google account, create a free API key, paste it in the config page',
  },
]);

const LOCAL_MODEL_DEFAULTS = { contextWindow: 32768, maxTokens: 8192 };

export async function detectIgnitionCandidates({ configService, localBaseUrl = null }) {
  const candidates = [];
  for (const entry of configService.configuredProviders()) {
    const models = await configService.listProviderModels(entry.id).catch(() => []);
    if (!models.length) continue;
    const cheapest = models[models.length - 1];
    candidates.push({
      kind: 'existing',
      ref: `${entry.id}/${cheapest.id}`,
      provider: entry.id,
      source: entry.source,
      cost: cheapest.cost ?? null,
    });
  }
  if (localBaseUrl) {
    const probe = await configService.probeLocalEndpoint(localBaseUrl).catch(error => ({
      reachable: false, error: String(error?.message ?? error), models: [],
    }));
    if (probe.reachable && probe.models.length) {
      candidates.push({
        kind: 'local',
        ref: `local/${probe.models[0]}`,
        provider: 'local',
        baseUrl: localBaseUrl,
        models: probe.models,
        needsRegistration: true,
      });
    } else {
      candidates.push({
        kind: 'local',
        ref: null,
        provider: 'local',
        baseUrl: localBaseUrl,
        unreachable: probe.reachable ? 'endpoint reported no models' : (probe.error ?? 'unreachable'),
      });
    }
  }
  for (const hint of FREE_CLOUD_HINTS) {
    candidates.push({ kind: 'free-cloud', provider: hint.provider, needsKey: true, how: hint.how });
  }
  return candidates;
}

export async function attemptIgnition({ configService, localBaseUrl = null }) {
  const candidates = await detectIgnitionCandidates({ configService, localBaseUrl });
  const attempts = [];
  let localRegistered = false;
  for (const candidate of candidates) {
    if (candidate.kind === 'free-cloud') continue;
    if (!candidate.ref) {
      attempts.push({ kind: candidate.kind, ref: null, ok: false, reason: `local endpoint unreachable: ${candidate.unreachable}` });
      continue;
    }
    if (candidate.kind === 'local' && candidate.needsRegistration && !localRegistered) {
      configService.upsertCustomProvider('local', {
        baseUrl: candidate.baseUrl,
        models: candidate.models.map(id => ({ id, ...LOCAL_MODEL_DEFAULTS })),
      });
      localRegistered = true;
    }
    const result = await configService.testModelRef(candidate.ref)
      .catch(error => ({ ok: false, reason: String(error?.message ?? error) }));
    attempts.push({
      kind: candidate.kind,
      ref: candidate.ref,
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason ?? 'model did not answer' }),
    });
    if (result.ok) {
      return {
        ignited: { ref: candidate.ref, kind: candidate.kind, source: candidate.source ?? candidate.kind },
        attempts,
        candidates,
      };
    }
  }
  return {
    ignited: null,
    attempts,
    candidates,
    fallback: {
      mode: 'manual',
      message: 'No model could be ignited. This is a supported state: configure by hand with the model-free paths (ariad config guide, or the dashboard config page) - the rule-based presets never needed a model. Ignition can be retried whenever any model becomes available.',
      nextActions: [
        ...FREE_CLOUD_HINTS.map(hint => `Free key: ${hint.how}`),
        'Paste any provider API key (config page or ariad config guide), then re-run: ariad config bootstrap',
        'Or start a local OpenAI-compatible server (llama.cpp / Ollama) and re-run: ariad config bootstrap',
      ],
    },
  };
}
