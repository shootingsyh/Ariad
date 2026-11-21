import { AsyncResource } from 'node:async_hooks';

export class ReconcileTrigger {
  /**
   * @param {{
   *   reconcile: () => Promise<void> | void,
   *   readGeneration: () => Promise<unknown> | unknown,
   *   safetyIntervalMs?: number,
   *   onError?: ((error: unknown) => void) | null,
   *   selfWakeDelayMs?: number,
   * }} options
   */
  constructor({ reconcile, readGeneration, safetyIntervalMs = 10 * 60 * 1000, onError = null, selfWakeDelayMs = 1000 }) {
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
    this.selfWakeDelayMs = selfWakeDelayMs;
    this.selfWakeTimer = null;
    this.lastPassDurationMs = 0;
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
    this.#clearSelfWake();
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
    if (this.stopped) return false;
    // An explicit wake supersedes a pending self-wake: the pass it triggers
    // re-reads the durable generation itself.
    this.#clearSelfWake();
    this.wakeGeneration += 1;
    this.#scheduleDrain();
    return true;
  }

  #clearSelfWake() {
    if (this.selfWakeTimer) clearTimeout(this.selfWakeTimer);
    this.selfWakeTimer = null;
  }

  #scheduleSelfWake() {
    if (this.selfWakeTimer || this.stopped) return;
    // A pass that mutated durable state must not retrigger itself
    // back-to-back: part of that mutation is the pass's own bookkeeping,
    // so an immediate rerun turns the trigger into a hot loop that starves
    // everything else on the event loop (2026-11-20: daemon main thread
    // pegged at one full core, CLI commands timing out). The rerun waits
    // at least selfWakeDelayMs and at least as long as the pass itself
    // took, so self-triggered passes stay under half the loop's time.
    const delayMs = Math.min(30_000, Math.max(this.selfWakeDelayMs, this.lastPassDurationMs));
    this.selfWakeTimer = setTimeout(() => {
      this.selfWakeTimer = null;
      if (this.stopped) return;
      this.wakeGeneration += 1;
      this.#scheduleDrain();
    }, delayMs);
    this.selfWakeTimer.unref?.();
  }

  async #drain() {
    if (this.running || this.stopped || this.processedWakeGeneration === this.wakeGeneration) return;
    this.running = true;
    const targetWakeGeneration = this.wakeGeneration;
    const passStartedAt = Date.now();
    try {
      const before = await this.readGeneration();
      await this.reconcile();
      const after = await this.readGeneration();
      this.lastPassDurationMs = Date.now() - passStartedAt;
      this.processedWakeGeneration = targetWakeGeneration;

      // A durable mutation that happened during the pass counts as more work
      // even if no explicit process-local wake accompanied it. The rerun is
      // scheduled as a delayed self-wake, never back-to-back (see
      // #scheduleSelfWake).
      if (after !== before && this.processedWakeGeneration === this.wakeGeneration) {
        this.#scheduleSelfWake();
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
