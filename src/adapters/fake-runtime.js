'use strict';

const {
  normalizeRunHandle,
  normalizeRuntimeResult,
} = require('../runtime-adapter');

function createFakeRuntimeAdapter(options = {}) {
  const script = Array.isArray(options.script) ? [...options.script] : [];
  const calls = [];
  const state = new Map();

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

  return {
    id: 'fake',
    config: options.config || {},
    calls,

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
}

module.exports = { createFakeRuntimeAdapter };
