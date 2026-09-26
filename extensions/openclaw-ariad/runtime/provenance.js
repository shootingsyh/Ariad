import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function pluginVersion() {
  try {
    return readJson(new URL('../package.json', import.meta.url))?.version ?? null;
  } catch {
    return null;
  }
}

function openClawVersion() {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve('openclaw'));
    for (let i = 0; i < 8; i += 1) {
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const pkg = readJson(file);
        if (pkg?.name === 'openclaw') return pkg.version ?? null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

export function detectExecutionProvenance({ env = process.env } = {}) {
  return {
    ariadCommit: env.ARIAD_COMMIT_SHA ?? env.GITHUB_SHA ?? null,
    pluginVersion: pluginVersion(),
    openclawVersion: openClawVersion(),
    runtime: 'openclaw-v2',
    controllerInstanceId: randomUUID(),
  };
}
