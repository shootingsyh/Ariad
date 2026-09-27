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
    this.queued = false;
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
      queueMicrotask(() => void this.#drain());
    });
  }

  wake(_reason = 'event') {
    if (this.stopped) return;
    this.queued = true;
    if (this.running) return;
    this.#scheduleDrain();
  }

  async #drain() {
    if (this.running || this.stopped || !this.queued) return;
    this.running = true;
    try {
      while (!this.stopped && this.queued) {
        this.queued = false;
        const before = await this.readGeneration();
        try {
          await this.reconcile();
        } catch (error) {
          this.onError?.(error);
        }
        const after = await this.readGeneration();
        if (after !== before) this.queued = true;
      }
    } finally {
      this.running = false;
      // Covers a wake racing with the final loop condition/finally boundary.
      if (!this.stopped && this.queued) this.#scheduleDrain();
    }
  }
}
