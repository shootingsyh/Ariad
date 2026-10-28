import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A build fingerprint for the running code: sha256 over package.json and
 * every src/**\/*.js file (path + content), truncated to 16 hex chars.
 * The daemon computes it once at startup and reports it on ping; the CLI
 * computes it from the current disk tree before trusting a daemon.
 * A mismatch means the daemon is executing code that is no longer what
 * is on disk (the classic failure: daemon started a minute before new
 * code landed, then served new commands with old logic for weeks).
 *
 * ARIAD_BUILD_ID overrides the computation — packaged installs without
 * a source tree, and tests that simulate a stale daemon.
 */
export function computeBuildId(treeRoot) {
  const hash = createHash('sha256');
  const pkgPath = join(treeRoot, 'package.json');
  if (existsSync(pkgPath)) {
    hash.update('package.json\0');
    hash.update(readFileSync(pkgPath));
    hash.update('\0');
  }
  const srcRoot = join(treeRoot, 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    }
  };
  if (existsSync(srcRoot)) walk(srcRoot);
  files.sort();
  for (const file of files) {
    hash.update(relative(treeRoot, file) + '\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function ariadBuildId() {
  const override = String(process.env.ARIAD_BUILD_ID ?? '').trim();
  if (override) return override;
  const treeRoot = fileURLToPath(new URL('../../', import.meta.url));
  return computeBuildId(treeRoot);
}
