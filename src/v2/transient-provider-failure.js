import { isNonretryableProviderFailure } from './nonretryable-provider-failure.js';

// Transient provider unavailability (model still loading, rate limit,
// gateway error, connection reset) is an environment condition, not task
// work. Retrying immediately only burns the failure ladder inside the
// provider's recovery window: on 2026-11-04 two healthy SRPG delivery
// tasks exhausted their three attempts in 22 seconds against a
// llama-server that needed minutes to load its model, and landed in
// SYSTEM_BLOCKED. Transient failures therefore never consume an attempt;
// the task waits out a cooldown before redispatch, and escalates to
// SYSTEM_BLOCKED only if the outage outlives the maximum window below.
const TRANSIENT_PATTERN = /PI_PROVIDER_ERROR: (?:429|500|502|503|504)\b|Loading model|model is loading|overloaded|rate limit|too many requests|service unavailable|temporarily unavailable|bad gateway|gateway timeout|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|socket hang up|connection reset|connection refused|fetch failed/i;

export function isTransientProviderFailure(failure) {
  if (isNonretryableProviderFailure(failure)) return false;
  return TRANSIENT_PATTERN.test(String(failure ?? ''));
}

function envMs(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

export function transientRetryCooldownMs() {
  return envMs('ARIAD_TRANSIENT_RETRY_COOLDOWN_MS', 5 * 60 * 1000, 1000, 60 * 60 * 1000);
}

export function transientRetryMaxWindowMs() {
  return envMs('ARIAD_TRANSIENT_RETRY_MAX_WINDOW_MS', 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
}

// Start of the current run of consecutive transient interruptions, or null.
// A role result or a system recovery closes the window, mirroring the
// backward scan systemFailureCount performs.
export function transientWindowStart(task) {
  const history = task?.history ?? [];
  let start = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type === 'ROLE_RESULT' || entry?.type === 'SYSTEM_RECOVERY') break;
    if (entry?.type === 'SYSTEM_INTERRUPTION' && entry?.transient === true && entry?.at) {
      start = entry.at;
    }
  }
  return start;
}

export function transientWindowExpired(task, now = Date.now()) {
  const start = transientWindowStart(task);
  if (!start) return false;
  const startedAt = Date.parse(start);
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt >= transientRetryMaxWindowMs();
}

export function isInTransientCooldown(task, now = Date.now()) {
  if (!task?.retryNotBefore) return false;
  const until = Date.parse(task.retryNotBefore);
  return Number.isFinite(until) && until > now;
}
