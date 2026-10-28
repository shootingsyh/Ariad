import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { runAriadCli } from '../src/runtime/cli.js';
import { defaultProjectsRoot } from '../src/runtime/project-manager.js';

test('ariad setup prepares global Pi provider auth without exposing credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-cli-setup-'));
  const original = process.env.ARIAD_PI_AUTH_PATH;
  process.env.ARIAD_PI_AUTH_PATH = path.join(root, 'auth.json');
  try {
    const result = runAriadCli(['setup']);
    assert.equal(result.action, 'setup');
    assert.equal(result.authPath, process.env.ARIAD_PI_AUTH_PATH);
    assert.equal(typeof result.providers['openai-codex'].ready, 'boolean');
    assert.equal(typeof result.providers.meta.ready, 'boolean');
    assert.equal(result.providers.llamacpp.ready, true);
    assert.equal('access' in result.providers['openai-codex'], false);
    assert.equal('key' in result.providers.meta, false);
  } finally {
    if (original === undefined) delete process.env.ARIAD_PI_AUTH_PATH;
    else process.env.ARIAD_PI_AUTH_PATH = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('standalone project root is always the default', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-project-root-'));
  try {
    assert.equal(defaultProjectsRoot(home), path.join(home, '.ariad', 'projects'));
    const legacy = path.join(home, '.openclaw', 'ariad', 'projects');
    fs.mkdirSync(legacy, { recursive: true });
    assert.equal(defaultProjectsRoot(home), path.join(home, '.ariad', 'projects'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
