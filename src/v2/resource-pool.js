export class ResourcePool {
  constructor(capacities = {}) {
    this.capacities = new Map(Object.entries(capacities));
    this.claims = new Map();
    // Fairness state: resource name -> Map(scope -> { since, lastTry }).
    // A scope that fails to claim a saturated resource registers as a
    // waiter. When the resource frees up, a claim from a scope that has
    // NOT been waiting must yield to the longest-waiting other scope
    // (provided that waiter is still actively retrying). Without this,
    // the project reconciled first in each service loop settles a
    // session and re-claims the freed slot inside its own tick, and a
    // second project sharing one local-llm slot starves indefinitely
    // (iterprobe stood READY for 40+ minutes behind SRPG, 2026-10-31).
    this.waiting = new Map();
    // A waiter counts only while it keeps retrying; entries go stale
    // after this window so an abandoned wait never blocks the pool.
    this.waitFreshMs = 15000;
  }

  // Fairness is keyed on the ScopedResourcePool prefix (the project id):
  // only explicitly scoped owners take part. Bare owners (a single
  // scheduler driving one project's pool directly) keep the legacy
  // semantics, where a task's own next stage re-claims ahead of other
  // ready tasks — stage continuity within one pipeline is intentional.
  #scopeOf(owner) {
    const text = String(owner);
    const idx = text.indexOf(':');
    return idx > 0 ? text.slice(0, idx) : null;
  }

  #waitEntry(resource, scope) {
    return this.waiting.get(resource)?.get(scope) ?? null;
  }

  #noteWait(resource, scope, now) {
    let byScope = this.waiting.get(resource);
    if (!byScope) {
      byScope = new Map();
      this.waiting.set(resource, byScope);
    }
    const existing = byScope.get(scope);
    if (existing) existing.lastTry = now;
    else byScope.set(scope, { since: now, lastTry: now });
  }

  #clearWait(resource, scope) {
    const byScope = this.waiting.get(resource);
    if (!byScope) return;
    byScope.delete(scope);
    if (byScope.size === 0) this.waiting.delete(resource);
  }

  #oldestFreshWaiter(resource, now) {
    const byScope = this.waiting.get(resource);
    if (!byScope) return null;
    let oldest = null;
    for (const [scope, entry] of byScope) {
      if (now - entry.lastTry > this.waitFreshMs) continue;
      if (!oldest || entry.since < oldest.since
        || (entry.since === oldest.since && scope < oldest.scope)) {
        oldest = { scope, since: entry.since };
      }
    }
    return oldest;
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
    const scope = this.#scopeOf(owner);
    const now = Date.now();
    for (const [name, amount] of need) {
      const capacity = this.capacities.get(name);
      if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`unknown resource: ${name}`);
      let used = 0;
      for (const claim of this.claims.values()) used += claim.get(name) ?? 0;
      if (used + amount > capacity) {
        if (scope) this.#noteWait(name, scope, now);
        return false;
      }
      // Capacity is available, but a longer-waiting scope gets priority:
      // yield and join the wait line behind it.
      if (scope) {
        const oldest = this.#oldestFreshWaiter(name, now);
        if (oldest && oldest.scope !== scope) {
          const mine = this.#waitEntry(name, scope);
          if (!mine || mine.since > oldest.since) {
            this.#noteWait(name, scope, now);
            return false;
          }
        }
      }
    }
    this.claims.set(owner, need);
    if (scope) for (const name of need.keys()) this.#clearWait(name, scope);
    return true;
  }

  release(owner) {
    return this.claims.delete(owner);
  }

  recover(tasks = []) {
    this.claims.clear();
    this.waiting.clear();
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

export class ScopedResourcePool {
  constructor(pool, scope) {
    this.pool = pool;
    this.scope = scope;
    this.owners = new Set();
  }

  #owner(owner) {
    return `${this.scope}:${owner}`;
  }

  claim(requirements = [], owner) {
    const scopedOwner = this.#owner(owner);
    const claimed = this.pool.claim(requirements, scopedOwner);
    if (claimed) this.owners.add(scopedOwner);
    return claimed;
  }

  release(owner) {
    const scopedOwner = this.#owner(owner);
    this.owners.delete(scopedOwner);
    return this.pool.release(scopedOwner);
  }

  recover(tasks = []) {
    for (const task of tasks) {
      if (task.state !== 'WORKING') continue;
      const resources = task.execution?.resources ?? [];
      if (!this.claim(resources, task.id)) {
        throw new Error(`resource capacity conflict while recovering task ${task.id}`);
      }
    }
  }

  releaseAll() {
    for (const owner of this.owners) this.pool.release(owner);
    this.owners.clear();
  }

  snapshot() {
    return this.pool.snapshot().filter(item => item.owner.startsWith(`${this.scope}:`));
  }
}
