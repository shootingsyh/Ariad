export class DurableResourceManager {
  constructor({ store, capacities = {}, defaultTtlMs = 30000 }) {
    if (!store || typeof store.acquire !== 'function') throw new Error('DurableResourceManager requires a lease store');
    this.store = store;
    this.capacities = { ...capacities };
    this.defaultTtlMs = defaultTtlMs;
    this.waiters = new Map();
  }

  #capacity(resource) {
    const value = this.capacities[resource];
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Unknown resource ${resource}`);
    return value;
  }

  #decorate(lease, ttlMs) {
    let released = false;
    return {
      ...lease,
      renew: () => {
        if (released) return this.store.get(lease.id);
        const next = this.store.renew(lease.id, ttlMs);
        Object.assign(lease, next);
        return next;
      },
      release: async () => {
        if (released) return this.store.get(lease.id);
        released = true;
        const next = this.store.release(lease.id);
        this.#wakeOne(lease.resource);
        return next;
      },
    };
  }

  tryAcquire(resource, owner, options = {}) {
    const capacity = this.#capacity(resource);
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const lease = this.store.acquire({ resource, owner, ttlMs, capacity });
    return lease ? this.#decorate(lease, ttlMs) : null;
  }

  acquire(resource, owner, options = {}) {
    const immediate = this.tryAcquire(resource, owner, options);
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const queue = this.waiters.get(resource) ?? [];
      queue.push({ owner, options, resolve, reject });
      this.waiters.set(resource, queue);
    });
  }

  #wakeOne(resource) {
    const queue = this.waiters.get(resource);
    if (!queue?.length) return;
    while (queue.length) {
      const waiter = queue.shift();
      try {
        const lease = this.tryAcquire(resource, waiter.owner, waiter.options);
        if (!lease) {
          queue.unshift(waiter);
          break;
        }
        waiter.resolve(lease);
        break;
      } catch (error) {
        waiter.reject(error);
      }
    }
    if (queue.length === 0) this.waiters.delete(resource);
  }

  reapExpired() {
    const expired = this.store.reapExpired();
    const resources = new Set(expired.map(x => x.resource));
    for (const resource of resources) this.#wakeOne(resource);
    return expired;
  }

  active(resource = null) {
    return this.store.listActive(resource);
  }
}
