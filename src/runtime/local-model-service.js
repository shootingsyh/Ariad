import { execFile } from 'node:child_process';

import { probeLocalEndpoint } from './config-service.js';

// A systemd user unit name: no shell metacharacters, no whitespace. The
// name is only ever passed as an argv element to systemctl, never through
// a shell; the pattern is defence in depth, not the primary guard.
const UNIT_PATTERN = /^[A-Za-z0-9_.@-]+$/;

export function isValidLocalModelServiceUnit(unit) {
  return typeof unit === 'string' && unit.length >= 1 && unit.length <= 128 && UNIT_PATTERN.test(unit);
}

function defaultStartService(unit) {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'start', unit], { timeout: 30000 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Make sure the configured local model endpoint is serving, starting its
 * systemd user service when it is not. Configured via the daemon config
 * key `localModelService` (`ariad config local-service <unit>`).
 *
 * Never throws: a local model is an optional accelerator, so a failure
 * here must not stop the daemon or any cloud-backed work. The caller is
 * expected to fire-and-forget this while the daemon starts serving.
 */
export async function ensureLocalModelService({
  baseUrl,
  serviceUnit,
  probe = probeLocalEndpoint,
  startService = defaultStartService,
  sleep = defaultSleep,
  timeoutMs = 180000,
  intervalMs = 2000,
  log = () => {},
} = {}) {
  if (!isValidLocalModelServiceUnit(serviceUnit)) {
    return { status: 'skipped', reason: 'no valid localModelService configured' };
  }
  try {
    const first = await probe(baseUrl);
    if (first?.reachable) return { status: 'already-up', baseUrl };
    log(`[local-model] endpoint ${baseUrl} not reachable (${first?.error ?? 'unknown error'}); starting ${serviceUnit}`);
    await startService(serviceUnit);
  } catch (error) {
    log(`[local-model] could not start ${serviceUnit}: ${error?.message ?? error}`);
    return { status: 'start-failed', reason: String(error?.message ?? error) };
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe(baseUrl).catch(() => null);
    if (result?.reachable) {
      log(`[local-model] endpoint ${baseUrl} is up`);
      return { status: 'started', baseUrl };
    }
    if (Date.now() >= deadline) {
      log(`[local-model] endpoint ${baseUrl} still not reachable after ${timeoutMs}ms`);
      return { status: 'timeout', baseUrl };
    }
    await sleep(intervalMs);
  }
}
