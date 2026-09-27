import { AsyncResource } from 'node:async_hooks';

export class ReconcileTrigger {
  /**
   * @param {{
   *   reconcile: () => Promise<void> | void,
   *   readGeneration: () => Promise<unknown> | unknown,
   *   safetyIntervalMs?: number,
   *   onError?: ((error: unknown) => void) | null,
   * }} options
   */
  constructor({ reconcile, readGeneration, safetyIntervalMs = 10 * 60 * 1000, onError = null }) {
    if (typeof reconcile !== 'function') throw new Error('reconcile is required');
    if (typeof readGeneration !== 'function') throw new Error('readGeneration is required');
    this.reconcile = reconcile;
    this.readGeneration = readGeneration;
    this.safetyIntervalMs = safetyIntervalMs;
    this.onError = onError;
    this.running = false;
    this.wakeGeneration = 0;
    this.processedWakeGeneration = 0;
    this.stopped = true;
    this.safetyTimer = null;
    // Created with the long-lived service, outside transient OpenClaw tool
    // requests. Scheduling through this resource prevents AsyncLocalStorage
    // request/model-override authority from leaking into background role runs.
    this.backgroundResource = new AsyncResource('AriadReconcileTrigger');
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.safetyTimer = setInterval(() => this.wake('safety'), this.safetyIntervalMs);
    this.safetyTimer.unref?.();
    this.wake('startup');
  }

  stop() {
    this.stopped = true;
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.safetyTimer = null;
  }

  #scheduleDrain() {
    this.backgroundResource.runInAsyncScope(() => {
      setImmediate(() => void this.#drain());
    });
  }

  wake(_reason = 'event') {
    if (this.stopped) return;
    // A monotonic in-memory wake generation makes coalescing explicit: many
    // wakes may collapse into one pass, but a wake can never be erased by a
    // racing drain boundary.
    this.wakeGeneration += 1;
    if (this.running) return;
    this.#scheduleDrain();
  }

  async #drain() {
    if (this.running || this.stopped || this.processedWakeGeneration === this.wakeGeneration) return;
    this.running = true;
    try {
      while (!this.stopped && this.processedWakeGeneration !== this.wakeGeneration) {
        const targetWakeGeneration = this.wakeGeneration;
        let before;
        try {
          before = await this.readGeneration();
          await this.reconcile();
          const after = await this.readGeneration();
          this.processedWakeGeneration = targetWakeGeneration;
          // Durable state may have changed without an explicit process-local
          // wake (for example, a mutation made during reconciliation). Treat
          // that as another generation of work.
          if (after !== before && this.processedWakeGeneration === this.wakeGeneration) {
            this.wakeGeneration += 1;
          }
        } catch (error) {
          // Consume this wake so a persistent error does not hot-spin. The
          // ten-minute safety wake (or any subsequent real event) retries it.
          this.processedWakeGeneration = targetWakeGeneration;
          this.onError?.(error);
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.processedWakeGeneration !== this.wakeGeneration) this.#scheduleDrain();
    }
  }
}
