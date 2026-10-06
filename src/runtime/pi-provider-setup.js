import { existsSync, readFileSync } from 'node:fs';

import { migrateLegacyPiAuth } from './pi-auth-migration.js';
import { ariadPiAuthPath } from './pi-runtime-config.js';
import { requireRuntimeDependencies } from './code-intelligence/project-capabilities.js';

function readAuth(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function setupPiProviders({ authPath = ariadPiAuthPath() } = {}) {
  const runtimeDependencies = requireRuntimeDependencies();
  const migration = migrateLegacyPiAuth(authPath, {
    providers: ['openai-codex', 'meta'],
  });
  const auth = existsSync(authPath) ? readAuth(authPath) : {};
  const providers = {
    openai: {
      ready: Boolean(process.env.OPENAI_API_KEY || auth.openai),
      source: process.env.OPENAI_API_KEY ? 'environment' : (auth.openai ? 'global-pi-auth' : 'not-configured'),
    },
    'openai-codex': {
      ready: Boolean(auth['openai-codex']),
      source: auth['openai-codex'] ? 'global-pi-auth' : 'not-configured',
    },
    meta: {
      ready: Boolean(process.env.META_API_KEY || auth.meta),
      source: process.env.META_API_KEY ? 'environment' : (auth.meta ? 'global-pi-auth' : 'not-configured'),
    },
    llamacpp: {
      ready: true,
      source: 'no-auth-required',
    },
  };

  return {
    authPath,
    runtimeDependencies,
    migratedProviders: migration.added,
    providers,
  };
}
