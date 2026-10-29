import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LSP_INSTALL_RECIPES,
  inspectProjectSlots,
  installProjectSlot,
} from '../src/runtime/plugin-slots.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { requiredModelRoles } from '../src/runtime/role-models.js';

function tempWorkspace(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-slots-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function withPath(dirs, fn) {
  const previous = process.env.PATH;
  process.env.PATH = dirs.join(':');
  try { return fn(); } finally { process.env.PATH = previous; }
}

function fakeBinaryDir(name) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-fakebin-'));
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return dir;
}

const FULL_MODELS = {
  tech_lead: 'openai/gpt-x', tech_lead_critic: 'openai/gpt-x', pm: 'openai/gpt-x',
  developer: 'openai/gpt-x', tester: 'openai/gpt-x', reviewer: 'openai/gpt-x',
  artist: 'openai/gpt-x', project_debugger: 'openai/gpt-x',
};

test('every detected language has an install recipe; godot is bundled, the rest are commands', () => {
  for (const language of ['gdscript', 'typescript', 'javascript', 'python', 'rust', 'go']) {
    assert.ok(LSP_INSTALL_RECIPES[language], `recipe for ${language}`);
  }
  assert.equal(LSP_INSTALL_RECIPES.gdscript.kind, 'bundled');
  assert.deepEqual(LSP_INSTALL_RECIPES.typescript.argv.slice(0, 3), ['npm', 'install', '-g']);
  assert.ok(LSP_INSTALL_RECIPES.go.argv.join(' ').includes('gopls'));
});

test('LSP slot state follows the server binary on PATH', () => {
  const workspace = tempWorkspace({ 'package.json': '{}', 'index.ts': 'export {};\n' });
  const binDir = fakeBinaryDir('typescript-language-server');
  const installed = withPath([binDir], () => inspectProjectSlots({ workspace, manifest: {} }));
  const tsSlot = installed.slots.find(slot => slot.slotId === 'lsp:typescript');
  assert.ok(tsSlot, 'typescript slot exists for a .ts workspace');
  assert.equal(tsSlot.state, 'installed');
  assert.equal(tsSlot.server, 'typescript-language-server');
  assert.equal(tsSlot.runtimeTier, 'search-fallback', 'non-Godot LSPs are honest: runtime still falls back to rg');

  const missing = withPath(['/nonexistent-bin'], () => inspectProjectSlots({ workspace, manifest: {} }));
  const missingSlot = missing.slots.find(slot => slot.slotId === 'lsp:typescript');
  assert.equal(missingSlot.state, 'missing');
  assert.equal(missingSlot.server, null);
  assert.equal(missingSlot.install.kind, 'command');
});

test('artist slot: enabled by default, ready only with a model, disabled on opt-out', () => {
  const workspace = tempWorkspace({ 'index.js': 'console.log(1);\n' });
  const ready = inspectProjectSlots({ workspace, manifest: { roleModels: { artist: 'openai/gpt-x' } } });
  assert.equal(ready.slots.at(-1).state, 'ready');
  const unconfigured = inspectProjectSlots({ workspace, manifest: { roleModels: {} } });
  assert.equal(unconfigured.slots.at(-1).state, 'unconfigured');
  const disabled = inspectProjectSlots({ workspace, manifest: { features: { artist: { enabled: false } }, roleModels: {} } });
  assert.equal(disabled.slots.at(-1).state, 'disabled');
  assert.equal(disabled.slots.at(-1).enabled, false);
});

test('install: command recipes run through the injected exec; bundled/feature/unknown slots refuse cleanly', async () => {
  const workspace = tempWorkspace({ 'package.json': '{}', 'index.ts': 'export {};\n' });
  const calls = [];
  const execFileImpl = (file, args, options, callback) => { calls.push([file, ...args]); callback(null, 'added 2 packages', ''); };
  const result = await withPath(['/nonexistent-bin'], () => installProjectSlot({ workspace, manifest: {} }, 'lsp:typescript', { execFileImpl }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].slice(0, 3), ['npm', 'install', '-g']);
  assert.ok(result.command.includes('typescript-language-server'));

  const godotWorkspace = tempWorkspace({ 'project.godot': '', 'main.gd': 'extends Node\n' });
  const bundled = await installProjectSlot({ workspace: godotWorkspace, manifest: {} }, 'lsp:gdscript', { execFileImpl });
  assert.equal(bundled.ok, false);
  assert.equal(bundled.reason, 'BUNDLED_WITH_ENGINE');

  const feature = await installProjectSlot({ workspace, manifest: {} }, 'feature:artist', { execFileImpl });
  assert.equal(feature.reason, 'CONFIGURE_NOT_INSTALL');
  const unknown = await installProjectSlot({ workspace, manifest: {} }, 'lsp:cobol', { execFileImpl });
  assert.equal(unknown.reason, 'SLOT_NOT_FOUND');
});

test('project create: artist opt-out drops the artist model requirement and persists the feature', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-slots-pm-'));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const withoutArtist = { ...FULL_MODELS };
  delete withoutArtist.artist;

  assert.throws(
    () => manager.create('needs-artist', { goal: 'g', roleModels: withoutArtist }),
    /missing: artist/,
  );
  const created = manager.create('no-artist', { goal: 'g', roleModels: withoutArtist, features: { artist: { enabled: false } } });
  assert.equal(created.features.artist.enabled, false);
  assert.equal(created.slots.slots.find(slot => slot.slotId === 'feature:artist').state, 'disabled');
  assert.deepEqual(requiredModelRoles({ artistEnabled: false }).includes('artist'), false);
  assert.equal(manager.status('no-artist').features.artist.enabled, false);
});
