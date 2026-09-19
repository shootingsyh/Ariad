export class ResourcePool {
  constructor(capacities = {}) {
    this.capacities = new Map(Object.entries(capacities));
    this.claims = new Map();
  }

  claim(requirements = [], owner) {
    if (this.claims.has(owner)) return true;
    const need = new Map();
    for (const resource of requirements) {
      const name = typeof resource === 'string' ? resource : resource?.name;
      const amount = typeof resource === 'string' ? 1 : (resource?.amount ?? 1);
      if (!name || !Number.isInteger(amount) || amount <= 0) throw new Error('invalid resource requirement');
      need.set(name, (need.get(name) ?? 0) + amount);
    }
    for (const [name, amount] of need) {
      const capacity = this.capacities.get(name);
      if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`unknown resource: ${name}`);
      let used = 0;
      for (const claim of this.claims.values()) used += claim.get(name) ?? 0;
      if (used + amount > capacity) return false;
    }
    this.claims.set(owner, need);
    return true;
  }

  release(owner) {
    return this.claims.delete(owner);
  }

  recover(tasks = []) {
    this.claims.clear();
    for (const task of tasks) {
      if (task.state !== 'WORKING') continue;
      const resources = task.execution?.resources ?? [];
      if (!this.claim(resources, task.id)) {
        throw new Error(`resource capacity conflict while recovering task ${task.id}`);
      }
    }
  }

  snapshot() {
    return [...this.claims.entries()].map(([owner, claim]) => ({
      owner,
      resources: [...claim.entries()].map(([name, amount]) => ({ name, amount })),
    }));
  }
}
