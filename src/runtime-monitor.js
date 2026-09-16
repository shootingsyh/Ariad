export class RuntimeMonitor {
  constructor({ adapter, intervalMs = 1000, emit = () => {} }) {
    if (!adapter || typeof adapter.probe !== 'function') {
      throw new Error('RuntimeMonitor requires an adapter with probe()');
    }
    this.adapter = adapter;
    this.intervalMs = intervalMs;
    this.emit = emit;
    this.running = false;
    this._timer = null;
    this._lastHealth = null;
    this._inFlight = null;
  }

  async _tick() {
    if (!this.running || this._inFlight) return;

    this._inFlight = (async () => {
      try {
        const result = await this.adapter.probe();
        const health = result.health;
        if (health !== this._lastHealth) {
          this._lastHealth = health;
          this.emit({
            type: 'RUNTIME_HEALTH_CHANGED',
            runtimeId: this.adapter.id,
            health,
            detail: result,
            at: new Date().toISOString(),
          });
        }
      } catch (error) {
        this.emit({
          type: 'RUNTIME_PROBE_FAILED',
          runtimeId: this.adapter.id,
          error: error?.message || String(error),
          at: new Date().toISOString(),
        });
      } finally {
        this._inFlight = null;
      }
    })();

    await this._inFlight;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this._tick();
    this._timer = setInterval(() => void this._tick(), this.intervalMs);
    this._timer.unref?.();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._inFlight) {
      await this._inFlight;
    }
  }
}
