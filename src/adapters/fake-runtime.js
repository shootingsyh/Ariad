import {
  normalizeRunHandle,
  normalizeRuntimeResult,
  normalizeHealth,
} from '../runtime-adapter.js';

export function createFakeRuntimeAdapter(options = {}) {
  const script = Array.isArray(options.script) ? [...options.script] : [];
  const healthScript = Array.isArray(options.healthScript) ? [...options.healthScript] : [];
  const probeErrors = Array.isArray(options.probeErrors) ? [...options.probeErrors] : [];
  const calls = [];
  const state = new Map();
  const handlesByRunId = new Map();
  let installed = false;
  let installCount = 0;
  let currentHealth = options.initialHealth || 'HEALTHY';

  function nextResult() {
    const item = script.length > 0 ? script.shift() : { outcome: 'PASS', result: null };
    return normalizeRuntimeResult({
      state: 'COMPLETED',
      outcome: item.outcome,
      result: Object.prototype.hasOwnProperty.call(item, 'result') ? item.result : null,
    });
  }

  function ensureHandle(runId) {
    if (handlesByRunId.has(runId)) return handlesByRunId.get(runId);
    const handle = normalizeRunHandle('fake', runId, `fake:${runId}`);
    handlesByRunId.set(runId, handle);
    state.set(handle.externalId, { status: 'RUNNING' });
    return handle;
  }

  return {
    id: 'fake',
    config: options.config || {},
    calls,
    get installCount() { return installCount; },
    get executionCount() { return handlesByRunId.size; },

    async install(context = {}) {
      calls.push({ operation: 'install', runtimeKey: context.runtimeKey || null });
      if (options.installError) throw options.installError;
      if (typeof options.onInstall === 'function') await options.onInstall(context);
      const changed = !installed;
      if (!installed) {
        installed = true;
        installCount += 1;
      }
      return { state: 'INSTALLED', changed };
    },

    async probe() {
      calls.push({ operation: 'probe' });
      if (probeErrors.length > 0) throw probeErrors.shift();
      if (healthScript.length > 0) currentHealth = healthScript.shift();
      return normalizeHealth({ health: currentHealth });
    },

    async start(request) {
      const duplicate = handlesByRunId.has(request.runId);
      calls.push({ operation: 'start', runId: request.runId, duplicate });
      return ensureHandle(request.runId);
    },

    async resume(request) {
      calls.push({ operation: 'resume', runId: request.runId, checkpoint: request.checkpoint });
      return ensureHandle(request.runId);
    },

    async poll(handle) {
      const current = state.get(handle.externalId);
      if (!current || current.status === 'CANCELLED') return { state: current?.status || 'LOST' };
      if (current.status === 'COMPLETED' && current.result) return current.result;
      const result = nextResult();
      state.set(handle.externalId, { status: result.state, result });
      return result;
    },

    async cancel(handle) {
      calls.push({ operation: 'cancel', runId: handle.runId });
      state.set(handle.externalId, { status: 'CANCELLED' });
      return { state: 'CANCELLED' };
    },
  };
}
