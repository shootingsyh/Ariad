import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureInterfaceArtifactLayout } from '../src/v2/interface-contracts.js';
import { sealDeveloperInterfaces } from '../src/v2/interface-seal.js';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function featureContract({ binding = null } = {}) {
  return {
    version: 1,
    nodeId: 'entry',
    nodeType: 'feature',
    decomposition: { kind: 'leaf', reason: 'entry is bounded' },
    interfaces: [{
      id: 'new-game',
      kind: 'provider', visibility: 'exported', contract: { input: [], produces: { thing: 'interactive surface', input: [], output: [], sideEffects: ['New Game starts a clean run.'] } },
    }],
    imports: [],
    integrationScenarios: [],
    featureUses: [],
    bindings: binding ? [binding] : [],
    featureTasks: [{
      id: 'entry-impl',
      title: 'Implement entry',
      intent: 'Implement new game.',
      acceptanceCriteria: ['New game is clean.'],
      testStrategy: 'Local entry test.',
      verification: [],
      interfaceIds: ['new-game'],
    }],
    taskLinks: [],
    integrationTasks: [],
  };
}

test('developer interface seal blocks when required binding is omitted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-dev-seal-missing-'));
  try {
    const artifactRoot = path.join(root, '.ariad', 'artifacts');
    const layout = ensureInterfaceArtifactLayout(artifactRoot);
    writeJson(path.join(layout.featureDir, 'entry.json'), featureContract());

    const seal = await sealDeveloperInterfaces({
      artifactRoot,
      workspace: root,
      task: { id: 'entry-impl' },
      result: { outcome: 'PASS', result: {} },
    });

    assert.equal(seal.required, true);
    assert.equal(seal.ok, false);
    assert.deepEqual(seal.failures, [{
      interfaceId: 'new-game',
      reason: 'MISSING_REALIZATION_BINDING',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('developer binding hint is independently resolved and persisted before seal succeeds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-dev-seal-hint-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', 'entry.gd'),
      'extends Node\n\nfunc new_game():\n\treturn true\n',
    );

    const artifactRoot = path.join(root, '.ariad', 'artifacts');
    const layout = ensureInterfaceArtifactLayout(artifactRoot);
    writeJson(path.join(layout.featureDir, 'entry.json'), featureContract());

    const seal = await sealDeveloperInterfaces({
      artifactRoot,
      workspace: root,
      task: { id: 'entry-impl' },
      result: {
        outcome: 'PASS',
        result: {
          interfaceRealizations: [{
            interfaceId: 'new-game',
            anchors: [{
              kind: 'symbol',
              file: 'scripts/entry.gd',
              symbol: 'new_game',
            }],
          }],
        },
      },
    });

    assert.equal(seal.ok, true);
    assert.deepEqual(seal.sealed, [{ interfaceId: 'new-game', validAnchors: 1 }]);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(layout.featureDir, 'entry.json'), 'utf8')
    );
    const anchor = persisted.bindings[0].realizationAnchors[0];
    assert.equal(anchor.status, 'VALID');
    assert.equal(anchor.file, 'scripts/entry.gd');
    assert.equal(anchor.symbol, 'new_game');
    assert.equal(typeof anchor.fileHash, 'string');
    assert.equal(anchor.fileHash.length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
