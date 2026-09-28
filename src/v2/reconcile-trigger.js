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
    this.scheduled = false;
    this.wakeGeneration = 0;
    this.processedWakeGeneration = 0;
    this.stopped = true;
    this.safetyTimer = null;
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
    if (this.scheduled || this.running || this.stopped) return;
    this.scheduled = true;
    this.backgroundResource.runInAsyncScope(() => {
      setImmediate(() => {
        this.scheduled = false;
        void this.#drain();
      });
    });
  }

  wake(_reason = 'event') {
    if (this.stopped) return;
    this.wakeGeneration += 1;
    this.#scheduleDrain();
  }

  async #drain() {
    if (this.running || this.stopped || this.processedWakeGeneration === this.wakeGeneration) return;
    this.running = true;
    const targetWakeGeneration = this.wakeGeneration;
    try {
      const before = await this.readGeneration();
      await this.reconcile();
      const after = await this.readGeneration();
      this.processedWakeGeneration = targetWakeGeneration;

      // A durable mutation that happened during the pass counts as more work
      // even if no explicit process-local wake accompanied it.
      if (after !== before && this.processedWakeGeneration === this.wakeGeneration) {
        this.wakeGeneration += 1;
      }
    } catch (error) {
      // Consume only the wake this pass attempted. A later real event or the
      // safety wake can retry without turning a persistent error into a hot loop.
      this.processedWakeGeneration = targetWakeGeneration;
      this.onError?.(error);
    } finally {
      this.running = false;
      // Yield between passes. This preserves single-flight/race safety without
      // an unbounded synchronous drain loop if each reconcile mutates state.
      if (!this.stopped && this.processedWakeGeneration !== this.wakeGeneration) {
        this.#scheduleDrain();
      }
    }
  }
}
