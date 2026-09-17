export function validateManagedComponent(component) {
  if (!component || typeof component !== 'object') throw new Error('managed component is required');
  if (typeof component.start !== 'function') throw new Error('managed component requires start()');
  if (typeof component.stop !== 'function') throw new Error('managed component requires stop()');
  return component;
}

export function validateHostLifecycle(host) {
  if (!host || typeof host !== 'object' || typeof host.register !== 'function') {
    throw new Error('host lifecycle requires register()');
  }
  return host;
}
