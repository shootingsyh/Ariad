export class ResourceManager {
  constructor(capacities = {}) {
    this.resources = new Map(Object.entries(capacities).map(([name, capacity]) => [name, { capacity, used: 0, waiters: [] }]));
  }
  acquire(resource, owner) {
    const r = this.resources.get(resource);
    if (!r) throw new Error(`Unknown resource ${resource}`);
    return new Promise(resolve => {
      const grant = () => {
        r.used += 1;
        let released = false;
        resolve({ resource, owner, release: () => {
          if (released) return;
          released = true;
          r.used -= 1;
          const next = r.waiters.shift();
          if (next) next();
        }});
      };
      if (r.used < r.capacity) grant(); else r.waiters.push(grant);
    });
  }
}
