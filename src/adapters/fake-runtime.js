'use strict';

const {
  normalizeRunHandle,
  normalizeRuntimeResult,
  normalizeHealth,
} = require('../runtime-adapter');

function createFakeRuntimeAdapter(options = {}) {
  const script = Array.isArray(options.script) ? [...options.script] : [];
  const healthScript = Array.isArray(options.healthScript) ? [...options.healthScript] : [];
  const probeErrors = Array.isArray(options.probeErrors) ? [...options.probeErrors] : [];
  const calls = [];
  const state = new Map();
  let installed = false;
  let installCount = 0;
  let currentHealth = options.initialHealth || 'HEALTHY';

  function nextResult() {
    const item = script.length > 0
      ? script.shift()
      : { outcome: 'PASS', result: null };
    return normalizeRuntimeResult({
      state: 'COMPLETED',
      outcome: item.outcome,
      result: Object.prototype.hasOwnProperty.call(item, 'result') ? item.result : null,
    });
  }

  const adapter = {
    id: 'fake',
    config: options.config || {},
    calls,

    get installCount() {
      return installCount;
    },

    async install(context = {}) {
      calls.push({ operation: 'install', runtimeKey: context.runtimeKey || null });
      if (!installed) {
        installed = true;
        installCount += 1;
      }
      return { state: 'INSTALLED', changed: installCount === 1 };
    },

    async probe() {
      calls.push({ operation: 'probe' });
      if (probeErrors.length > 0) {
        throw probeErrors.shift();
      }
      if (healthScript.length > 0) {
        currentHealth = healthScript.shift();
      }
      return normalizeHealth({ health: currentHealth });
    },

    async start(request) {
      calls.push({ operation: 'start', runId: request.runId });
      const handle = normalizeRunHandle('fake', request.runId, `fake:${request.runId}`);
      state.set(handle.externalId, { status: 'RUNNING' });
      return handle;
    },

    async resume(request) {
      calls.push({
        operation: 'resume',
        runId: request.runId,
        checkpoint: request.checkpoint,
      });
      const handle = normalizeRunHandle('fake', request.runId, `fake:${request.runId}`);
      state.set(handle.externalId, { status: 'RUNNING' });
      return handle;
    },

    async poll(handle) {
      const current = state.get(handle.externalId);
      if (!current || current.status === 'CANCELLED') {
        return { state: current?.status || 'LOST' };
      }
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

  return adapter;
}

module.exports = { createFakeRuntimeAdapter };
