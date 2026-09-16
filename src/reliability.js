export class ReliabilityService {
  constructor(options = {}) {
    this.policies = options.policies ?? {};
    this.execute = options.execute ?? (async () => false);
    this.recoveryKey = options.recoveryKey ?? (incident => `${incident.type}:${incident.target}`);
    this.incidentStore = options.incidentStore ?? null;
    this.incidents = new Map();
    this.seq = 0;
    this.locks = new Map();
  }

  #save(incident) {
    if (this.incidentStore) return this.incidentStore.save(structuredClone(incident));
    this.incidents.set(incident.id, structuredClone(incident));
    return structuredClone(incident);
  }

  #load(id) {
    if (this.incidentStore) return this.incidentStore.get(id);
    const incident = this.incidents.get(id);
    if (!incident) throw new Error(`Unknown incident ${id}`);
    return structuredClone(incident);
  }

  detect(type, target) {
    if (this.incidentStore) return this.incidentStore.create(type, target);
    const incident = { id: `INC-${++this.seq}`, type, target, state: 'OPEN', recoveryStep: 0, activeAction: null, events: [] };
    this.incidents.set(incident.id, incident);
    return structuredClone(incident);
  }

  list() {
    if (this.incidentStore) return this.incidentStore.list();
    return [...this.incidents.values()].map(x => structuredClone(x));
  }

  get(id) { return this.#load(id); }

  async #withLock(key, fn) {
    while (this.locks.has(key)) await this.locks.get(key);
    let release;
    const p = new Promise(r => { release = r; });
    this.locks.set(key, p);
    try { return await fn(); } finally { this.locks.delete(key); release(); }
  }

  async recover(id) {
    let incident = this.#load(id);
    const steps = this.policies[incident.type] ?? [];
    const key = this.recoveryKey(incident);

    return this.#withLock(key, async () => {
      incident = this.#load(id);
      incident.state = 'RECOVERING';
      this.#save(incident);

      for (let idx = incident.recoveryStep; idx < steps.length; idx++) {
        const action = steps[idx];
        incident.activeAction = action;
        incident.events.push({ action, state: 'STARTED' });
        this.#save(incident);

        let ok;
        try {
          ok = await this.execute(action, structuredClone(incident));
        } catch (error) {
          incident.events.push({ action, state: 'INTERRUPTED', error: error?.message || String(error) });
          this.#save(incident);
          throw error;
        }

        incident = this.#load(id);
        incident.recoveryStep = idx + 1;
        incident.activeAction = null;
        incident.events.push({ action, state: ok ? 'SUCCEEDED' : 'FAILED' });
        if (ok) {
          incident.state = 'RECOVERED';
          return this.#save(incident);
        }
        this.#save(incident);
      }

      incident = this.#load(id);
      incident.activeAction = null;
      incident.state = 'ESCALATED';
      return this.#save(incident);
    });
  }
}
