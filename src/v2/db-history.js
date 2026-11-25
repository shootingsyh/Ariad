// db-history: a git-committed changeset history for a project's
// state.db.
//
// A SQLite session rides the store's single shared connection and
// records every change made on it. capture() drains the session into
// the next numbered changeset file under
// <workspace>/.ariad/db-history/cs/; a baseline.db (a full VACUUM INTO
// snapshot) anchors the chain. The project repo's pre-commit hook
// calls `ariad project db-capture` on every commit and stages the
// history directory, so the diff rides along with the project's own
// commits - no separate backup commits, no full snapshots in git.
// Restore = baseline + changesets applied in order + integrity_check.
//
// Sessions do not record schema changes, so the baseline rotates when
// the storage anchor changes; it also rotates when the chain grows
// past its limits, and whenever the store handle was replaced without
// a pre-reopen flush (an unrecorded gap would poison the chain - the
// flush hook registered with store-connection makes that the rare
// path, e.g. a hard crash between writes and reopen).

import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_MAX_CHAIN_FILES = 200;
const DEFAULT_MAX_CHAIN_BYTES = 64 * 1024 * 1024;

export class DbHistory {
  constructor({
    dbFile,
    historyDir,
    getHandle,
    anchor = null,
    maxChainFiles = DEFAULT_MAX_CHAIN_FILES,
    maxChainBytes = DEFAULT_MAX_CHAIN_BYTES,
  }) {
    if (!dbFile || !historyDir || typeof getHandle !== 'function') {
      throw new Error('DbHistory requires dbFile, historyDir and getHandle()');
    }
    this.dbFile = dbFile;
    this.historyDir = historyDir;
    this.getHandle = getHandle;
    this.anchor = anchor;
    this.maxChainFiles = maxChainFiles;
    this.maxChainBytes = maxChainBytes;
    this.handle = null;
    this.session = null;
    this.gap = false;
  }

  get manifestPath() { return join(this.historyDir, 'manifest.json'); }
  get baselinePath() { return join(this.historyDir, 'baseline.db'); }
  get csDir() { return join(this.historyDir, 'cs'); }

  readManifest() {
    try { return JSON.parse(readFileSync(this.manifestPath, 'utf8')); }
    catch { return null; }
  }

  writeManifest(manifest) {
    mkdirSync(this.historyDir, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  // Returns the live session, attaching one to the current shared
  // handle. A handle that changed since the last attach without a
  // flush marks a gap: the chain can no longer be trusted past it.
  ensureSession() {
    let handle = null;
    try { handle = this.getHandle(); } catch { handle = null; }
    if (!handle || handle.isOpen === false) return null;
    if (this.session && this.handle === handle) return this.session;
    if (this.session) {
      try { this.session.close(); } catch { /* already gone */ }
      this.session = null;
      this.gap = true;
    }
    this.handle = handle;
    this.session = handle.createSession();
    return this.session;
  }

  swapSession() {
    const handle = this.handle;
    try { this.session?.close(); } catch { /* ignore */ }
    this.session = null;
    if (handle && handle.isOpen !== false) {
      this.session = handle.createSession();
    } else {
      this.handle = null;
    }
  }

  capture() {
    const session = this.ensureSession();
    if (!session) return { captured: false, reason: 'no live store handle' };
    const manifest = this.readManifest();
    if (!manifest || !existsSync(this.baselinePath)) {
      const r = this.rotate('no baseline yet');
      return { captured: false, rotated: r.rotated === true, reason: r.reason ?? 'baseline created' };
    }
    if (this.anchor != null && manifest.anchor !== this.anchor) {
      const r = this.rotate(`storage anchor changed (${manifest.anchor ?? 'none'} -> ${this.anchor})`);
      return { captured: false, rotated: r.rotated === true, reason: r.reason ?? 'baseline rotated' };
    }
    if (this.gap) {
      this.gap = false;
      const r = this.rotate('store handle was replaced without a pre-reopen flush');
      return { captured: false, rotated: r.rotated === true, reason: r.reason ?? 'baseline rotated after gap' };
    }
    let cs;
    try { cs = session.changeset(); }
    catch (e) { return { captured: false, reason: `changeset failed: ${e?.message ?? e}` }; }
    if (!cs || cs.length === 0) return { captured: false, empty: true };
    const seq = manifest.nextSeq ?? 1;
    const name = `cs/${String(seq).padStart(6, '0')}.bin`;
    mkdirSync(this.csDir, { recursive: true });
    writeFileSync(join(this.historyDir, name), cs);
    this.swapSession();
    const next = {
      ...manifest,
      nextSeq: seq + 1,
      chainFiles: (manifest.chainFiles ?? 0) + 1,
      chainBytes: (manifest.chainBytes ?? 0) + cs.length,
      lastCaptureAt: new Date().toISOString(),
    };
    this.writeManifest(next);
    if (next.chainFiles > this.maxChainFiles || next.chainBytes > this.maxChainBytes) {
      this.rotate('chain limits exceeded');
      return { captured: true, bytes: cs.length, rotated: true };
    }
    return { captured: true, file: name, bytes: cs.length };
  }

  // Re-anchor the chain: the current database state becomes the new
  // baseline (absorbing any un-captured session changes with it) and
  // the changeset chain restarts empty.
  rotate(reason) {
    let handle = null;
    try { handle = this.getHandle(); } catch { handle = null; }
    if (!handle || handle.isOpen === false) return { rotated: false, reason: 'no live store handle' };
    try { this.session?.close(); } catch { /* ignore */ }
    this.session = null;
    this.handle = null;
    mkdirSync(this.historyDir, { recursive: true });
    const tmp = join(this.historyDir, 'baseline.db.tmp');
    for (const suffix of ['', '-wal', '-shm']) rmSync(tmp + suffix, { force: true });
    handle.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    renameSync(tmp, this.baselinePath);
    rmSync(this.csDir, { recursive: true, force: true });
    mkdirSync(this.csDir, { recursive: true });
    this.writeManifest({
      version: 1,
      anchor: this.anchor,
      baselineAt: new Date().toISOString(),
      baselineReason: reason,
      nextSeq: 1,
      chainFiles: 0,
      chainBytes: 0,
      lastCaptureAt: null,
    });
    this.ensureSession();
    return { rotated: true };
  }

  // store-connection before-reopen hook: drain the pending changeset
  // to disk while the old handle (and its session) is still alive, so
  // a handle replacement never opens a gap in the chain. The file
  // waits in the working tree for the next project commit.
  flushForReopen(box) {
    if (!box || box.key == null) return;
    if (resolve(box.file) !== resolve(this.dbFile)) return;
    try { this.capture(); } catch { /* reopen proceeds regardless */ }
  }
}

// Rebuild a database from a history directory: baseline first, then
// every changeset in sequence order. Refuses to overwrite an existing
// target and verifies integrity before calling it done.
export function restoreDbHistory(historyDir, targetFile) {
  const baseline = join(historyDir, 'baseline.db');
  if (!existsSync(baseline)) throw new Error(`DB_HISTORY_NO_BASELINE: no baseline.db in ${historyDir}`);
  if (existsSync(targetFile)) throw new Error(`DB_HISTORY_TARGET_EXISTS: ${targetFile}`);
  copyFileSync(baseline, targetFile);
  const db = new DatabaseSync(targetFile);
  try {
    const csDir = join(historyDir, 'cs');
    const files = existsSync(csDir)
      ? readdirSync(csDir).filter(name => name.endsWith('.bin')).sort()
      : [];
    for (const name of files) db.applyChangeset(readFileSync(join(csDir, name)));
    const row = db.prepare('PRAGMA integrity_check').get();
    const verdict = row ? Object.values(row)[0] : null;
    if (verdict !== 'ok') throw new Error(`DB_HISTORY_RESTORE_CORRUPT: integrity_check: ${verdict}`);
    return { file: targetFile, changesetsApplied: files.length };
  } finally {
    db.close();
  }
}

const HOOK_BEGIN = '# >>> ariad db-history (managed) >>>';
const HOOK_END = '# <<< ariad db-history (managed) <<<';

// Ensures the project repo's pre-commit hook carries the db-history
// block: on every project commit, ask the daemon to drain the pending
// changeset into .ariad/db-history and stage it, so the diff rides
// along with that very commit. Best-effort by design - the block
// never blocks a commit, and this installer never rewrites an
// existing block.
export function ensureDbHistoryHook({ workspace, projectId, cliFile }) {
  const gitDir = join(workspace, '.git');
  if (!existsSync(gitDir)) return { installed: false, reason: 'no .git directory at the workspace root' };
  const hooksDir = join(gitDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  const block = [
    HOOK_BEGIN,
    '# Ariad db-history: capture the state.db changeset into this commit.',
    '# Best-effort: never blocks the commit.',
    `node ${JSON.stringify(cliFile)} project db-capture ${projectId} >/dev/null 2>&1 || true`,
    'git add -- .ariad/db-history >/dev/null 2>&1 || true',
    HOOK_END,
    '',
  ].join('\n');
  let current = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '#!/bin/bash\n';
  if (current.includes(HOOK_BEGIN)) return { installed: false, reason: 'already present' };
  if (!current.endsWith('\n')) current += '\n';
  writeFileSync(hookPath, current + block);
  chmodSync(hookPath, 0o755);
  return { installed: true, hook: hookPath };
}
