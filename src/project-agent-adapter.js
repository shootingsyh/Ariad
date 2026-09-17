const REQUIRED_METHODS = ['bindProject', 'notify', 'submitDecision'];

export function validateProjectAgentAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('project agent adapter is required');
  if (typeof adapter.id !== 'string' || adapter.id.trim() === '') throw new Error('project agent adapter requires id');
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') throw new Error(`project agent adapter ${adapter.id} requires ${method}()`);
  }
  return adapter;
}
