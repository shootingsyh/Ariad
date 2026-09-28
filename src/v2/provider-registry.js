function validateProvider(provider) {
  if (!provider?.id) throw new Error('provider requires id');
  for (const method of ['start', 'poll', 'cancel']) {
    if (typeof provider[method] !== 'function') throw new Error(`provider ${provider.id} requires ${method}()`);
  }
  return provider;
}

export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    validateProvider(provider);
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`unknown provider: ${id}`);
    return provider;
  }
}
