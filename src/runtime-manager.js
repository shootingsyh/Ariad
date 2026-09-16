'use strict';

const { RuntimeMonitor } = require('./runtime-monitor');

class RuntimeManager {
  constructor({ registry, monitorFactory, emit = () => {}, monitorIntervalMs = 1000 }) {
    if (!registry || typeof registry.list !== 'function' || typeof registry.get !== 'function') {
      throw new Error('RuntimeManager requires a runtime registry');
    }
    this.registry = registry;
    this.emit = emit;
    this.monitorIntervalMs = monitorIntervalMs;
    this.monitorFactory = monitorFactory || (({ adapter }) => new RuntimeMonitor({
      adapter,
      intervalMs: this.monitorIntervalMs,
      emit: this.emit,
    }));
    this.monitors = new Map();
    this.status = new Map();
    this.running = false;
  }

  async start() {
    if (this.running) return this.listStatus();

    const started = [];
    try {
      for (const { key } of this.registry.list()) {
        const adapter = this.registry.get(key);
        await adapter.install({ runtimeKey: key });
        const health = await adapter.probe();
        this.status.set(key, {
          key,
          runtimeId: adapter.id,
          health: health.health,
        });
      }

      for (const { key } of this.registry.list()) {
        const adapter = this.registry.get(key);
        const monitor = this.monitorFactory({ key, adapter, emit: this.emit });
        this.monitors.set(key, monitor);
        await monitor.start();
        started.push(monitor);
      }

      this.running = true;
      return this.listStatus();
    } catch (error) {
      for (const monitor of started.reverse()) {
        try { await monitor.stop(); } catch (_) {}
      }
      this.monitors.clear();
      this.running = false;
      throw error;
    }
  }

  async stop() {
    if (!this.running && this.monitors.size === 0) return;
    const monitors = [...this.monitors.values()].reverse();
    this.monitors.clear();
    this.running = false;
    for (const monitor of monitors) {
      await monitor.stop();
    }
  }

  getStatus(key) {
    if (!this.status.has(key)) throw new Error(`unknown runtime status: ${key}`);
    return { ...this.status.get(key) };
  }

  listStatus() {
    return this.registry.list()
      .filter(({ key }) => this.status.has(key))
      .map(({ key }) => ({ ...this.status.get(key) }));
  }
}

module.exports = { RuntimeManager };
