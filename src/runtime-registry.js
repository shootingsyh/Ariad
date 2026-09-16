import { validateRuntimeAdapter } from './runtime-adapter.js';

export class RuntimeRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(key, adapter, options = {}) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('runtime key must be a non-empty string');
    }
    validateRuntimeAdapter(adapter);
    if (this.adapters.has(key) && !options.replace) {
      throw new Error(`runtime ${key} already registered`);
    }
    this.adapters.set(key, adapter);
    return adapter;
  }

  get(key) {
    if (!this.adapters.has(key)) {
      throw new Error(`unknown runtime: ${key}`);
    }
    return this.adapters.get(key);
  }

  has(key) {
    return this.adapters.has(key);
  }

  list() {
    return [...this.adapters.entries()].map(([key, adapter]) => ({ key, id: adapter.id }));
  }
}
