import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileReconcileWake {
  /**
   * @param {string} file
   * @param {{ onError?: ((error: unknown) => void) | null }} [options]
   */
  constructor(file, { onError = null } = {}) {
    if (!file) throw new Error('FileReconcileWake requires a file path');
    this.file = file;
    this.onError = onError;
    this.watcher = null;
    this.sequence = 0;
    this.#ensureFile();
  }

  #ensureFile() {
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) writeFileSync(this.file, '', 'utf8');
  }

  emit(reason = 'event') {
    try {
      this.#ensureFile();
      this.sequence += 1;
      writeFileSync(
        this.file,
        `${process.pid}:${Date.now()}:${this.sequence}:${String(reason)}\n`,
        'utf8'
      );
      return true;
    } catch (error) {
      this.onError?.(error);
      return false;
    }
  }

  start(onWake) {
    if (this.watcher) return;
    if (typeof onWake !== 'function') throw new Error('FileReconcileWake.start requires onWake');
    this.#ensureFile();
    this.watcher = watch(this.file, { persistent: false }, () => {
      try {
        onWake();
      } catch (error) {
        this.onError?.(error);
      }
    });
    this.watcher.on?.('error', (error) => this.onError?.(error));
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
  }
}
