export class RuntimeAdapterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeAdapterError';
  }
}

const REQUIRED_METHODS = ['install', 'probe', 'start', 'resume', 'poll', 'cancel'];

export function validateRuntimeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new RuntimeAdapterError('runtime adapter must be an object');
  }
  if (typeof adapter.id !== 'string' || adapter.id.trim() === '') {
    throw new RuntimeAdapterError('runtime adapter requires a stable string id');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new RuntimeAdapterError(`runtime adapter ${adapter.id} requires ${method}()`);
    }
  }
  return adapter;
}

export function normalizeRunHandle(runtimeId, runId, externalId, state = 'RUNNING') {
  if (!runtimeId || !runId || !externalId) {
    throw new RuntimeAdapterError('run handle requires runtimeId, runId, and externalId');
  }
  return { runtimeId, runId, externalId, state };
}

export function normalizeRuntimeResult(value) {
  if (!value || typeof value !== 'object' || typeof value.state !== 'string') {
    throw new RuntimeAdapterError('runtime result requires a state');
  }
  return value;
}

export function normalizeHealth(value) {
  const health = typeof value === 'string' ? value : value?.health;
  if (!['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN'].includes(health)) {
    throw new RuntimeAdapterError('runtime probe requires a normalized health state');
  }
  return typeof value === 'string' ? { health } : { ...value, health };
}
