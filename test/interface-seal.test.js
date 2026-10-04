import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveAnchor,
  resolveAnchorStatically,
  sealInterface,
} from '../src/runtime/code-intelligence/interface-seal.js';

test('static GDScript interface seal resolves exact function range and fails after symbol drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-interface-seal-'));
  try {
    const file = path.join(root, 'scripts', 'game_state.gd');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      'extends Node',
      '',
      'func new_game():',
      '\treset_state()',
      '\treturn true',
      '',
      'func continue_game():',
      '\treturn true',
      '',
    ].join('\n'));

    const anchor = {
      kind: 'symbol',
      file: 'scripts/game_state.gd',
      symbol: 'GameState.new_game',
      status: 'VALID',
    };

    const resolved = resolveAnchorStatically({ workspace: root, anchor });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.range, { startLine: 3, endLine: 6, truncated: false });
    assert.equal(resolved.snippet.some(row => row.text.includes('reset_state')), true);

    const seal = await sealInterface({
      workspace: root,
      featureId: 'entry',
      interfaceContract: {
        id: 'new-game',
        realization: [anchor],
        verification: [],
      },
    });
    assert.equal(seal.ok, true);

    fs.writeFileSync(file, [
      'extends Node',
      '',
      'func start_campaign():',
      '\treturn true',
      '',
    ].join('\n'));

    const broken = await sealInterface({
      workspace: root,
      featureId: 'entry',
      interfaceContract: {
        id: 'new-game',
        realization: [anchor],
        verification: [],
      },
    });
    assert.equal(broken.ok, false);
    assert.equal(broken.failures[0].reason, 'SYMBOL_NOT_FOUND');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LSP resolution is preferred when available and static resolution remains fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-interface-lsp-'));
  try {
    const file = path.join(root, 'scripts', 'entry.gd');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      'extends Node',
      '',
      'func new_game():',
      '\treturn true',
      '',
    ].join('\n'));

    const fakeLsp = {
      async findSymbol(_file, symbol) {
        assert.equal(symbol, 'new_game');
        return {
          name: 'new_game',
          selectionRange: {
            start: { line: 2, character: 0 },
            end: { line: 3, character: 13 },
          },
        };
      },
    };

    const resolved = await resolveAnchor({
      workspace: root,
      anchor: { kind: 'symbol', file: 'scripts/entry.gd', symbol: 'new_game' },
      codeIntelligence: fakeLsp,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.resolver, 'lsp');
    assert.deepEqual(resolved.range, { startLine: 3, endLine: 4 });

    const fallback = await resolveAnchor({
      workspace: root,
      anchor: { kind: 'symbol', file: 'scripts/entry.gd', symbol: 'new_game' },
      codeIntelligence: { async findSymbol() { throw new Error('offline'); } },
    });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.resolver, 'static');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
