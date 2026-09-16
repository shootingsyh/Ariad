export class ReliabilityService {
  constructor(options = {}) {
    this.policies = options.policies ?? {};
    this.execute = options.execute ?? (async () => false);
    this.recoveryKey = options.recoveryKey ?? (incident => `${incident.type}:${incident.target}`);
    this.incidents = new Map();
    this.seq = 0;
    this.locks = new Map();
  }
  detect(type, target) {
    const incident = { id: `INC-${++this.seq}`, type, target, state: 'OPEN', recoveryStep: 0, events: [] };
    this.incidents.set(incident.id, incident);
    return structuredClone(incident);
  }
  list() { return [...this.incidents.values()].map(x => structuredClone(x)); }
  get(id) { const i = this.incidents.get(id); if (!i) throw new Error(`Unknown incident ${id}`); return structuredClone(i); }
  async #withLock(key, fn) {
    while (this.locks.has(key)) await this.locks.get(key);
    let release;
    const p = new Promise(r => { release = r; });
    this.locks.set(key, p);
    try { return await fn(); } finally { this.locks.delete(key); release(); }
  }
  async recover(id) {
    const incident = this.incidents.get(id);
    if (!incident) throw new Error(`Unknown incident ${id}`);
    incident.state = 'RECOVERING';
    const steps = this.policies[incident.type] ?? [];
    const key = this.recoveryKey(incident);
    return this.#withLock(key, async () => {
      for (let idx = incident.recoveryStep; idx < steps.length; idx++) {
        const action = steps[idx];
        incident.recoveryStep = idx + 1;
        incident.events.push({ action });
        if (await this.execute(action, structuredClone(incident))) {
          incident.state = 'RECOVERED';
          return structuredClone(incident);
        }
      }
      incident.state = 'ESCALATED';
      return structuredClone(incident);
    });
  }
}
