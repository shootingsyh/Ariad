import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureInterfaceArtifactLayout } from '../src/v2/interface-contracts.js';
import { buildRoleBoundaryContext } from '../src/v2/role-boundary-context.js';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function featureNode(root, id, parentId, title = id) {
  write(path.join(root, 'planner', 'logical', `${id}.json`), {
    id, title, summary: `${title} summary`, parentId,
  });
}

function milestoneNode(root, id, parentId, title = id) {
  write(path.join(root, 'planner', 'milestones', `${id}.json`), {
    id, title, goal: `${title} goal`, parentId,
    dependsOn: [], logicalRefs: [], acceptanceCriteria: [`${title} accepted`],
    testStrategy: `${title} integration test`, tasks: [],
  });
}

function contract(root, nodeType, id, extra = {}) {
  const layout = ensureInterfaceArtifactLayout(root);
  const dir = nodeType === 'feature' ? layout.featureDir : layout.milestoneDir;
  write(path.join(dir, `${id}.json`), {
    version: 1,
    nodeId: id,
    nodeType,
    decomposition: { kind: 'leaf', reason: 'fixture' },
    interfaces: [],
    imports: [],
    featureUses: [],
    integrationScenarios: [],
    bindings: [],
    featureTasks: [],
    taskLinks: [],
    integrationTasks: [],
    ...extra,
  });
}

test('SRPG-style developer context stays on its feature boundary while tester sees milestone composition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-role-context-'));
  try {
    write(path.join(root, 'scripts', 'entry.gd'), "extends Node\n\nfunc new_game():\n\treturn true\n\nfunc internal_load():\n\treturn true\n");
    write(path.join(root, 'scripts', 'progression.gd'), "extends Node\n\nfunc equip_persist():\n\treturn true\n");

    featureNode(root, 'srpg', null, 'SRPG');
    featureNode(root, 'entry', 'srpg', 'Entry lifecycle');
    featureNode(root, 'progression', 'srpg', 'Progression');
    featureNode(root, 'battle', 'srpg', 'Battle');

    contract(root, 'feature', 'srpg', {
      decomposition: { kind: 'expand', reason: 'product capabilities' },
      interfaces: [{ id: 'playable', type: 'journey', visibility: 'exported', contract: 'Product is playable.' }],
      imports: [
        { fromNodeId: 'entry', interfaceId: 'new-game', purpose: 'start product journey' },
        { fromNodeId: 'progression', interfaceId: 'equip-persist', purpose: 'persist player progression' },
      ],
    });
    contract(root, 'feature', 'entry', {
      interfaces: [
        { id: 'new-game', type: 'ui', visibility: 'exported', contract: 'Title New Game starts a clean run.' },
        { id: 'load-save-internal', type: 'service', visibility: 'internal', contract: 'Internal load helper.' },
      ],
      bindings: [
        {
          interfaceId: 'new-game',
          realizationAnchors: [{ kind: 'symbol', file: 'scripts/entry.gd', symbol: 'new_game', status: 'VALID' }],
          verificationAnchors: [],
        },
        {
          interfaceId: 'load-save-internal',
          realizationAnchors: [{ kind: 'symbol', file: 'scripts/entry.gd', symbol: 'internal_load', status: 'VALID' }],
          verificationAnchors: [],
        },
      ],
      featureTasks: [{
        id: 'entry-impl',
        title: 'Implement entry',
        intent: 'Implement new-game lifecycle.',
        acceptanceCriteria: ['New game is clean.'],
        testStrategy: 'Local entry tests.',
        verification: [],
        interfaceIds: ['new-game'],
      }],
    });
    contract(root, 'feature', 'progression', {
      interfaces: [{ id: 'equip-persist', type: 'journey', visibility: 'exported', contract: 'Equipment survives save/continue.' }],
      bindings: [{
        interfaceId: 'equip-persist',
        realizationAnchors: [{ kind: 'symbol', file: 'scripts/progression.gd', symbol: 'equip_persist', status: 'VALID' }],
        verificationAnchors: [],
      }],
    });
    contract(root, 'feature', 'battle', {
      interfaces: [{ id: 'win', type: 'event', visibility: 'exported', contract: 'Battle produces a real WIN.' }],
    });

    milestoneNode(root, 'V2', null, 'V2');
    milestoneNode(root, 'V2.1', 'V2', 'Entry/progression');
    contract(root, 'milestone', 'V2', {
      decomposition: { kind: 'expand', reason: 'delivery phases' },
      interfaces: [{ id: 'release-journey', type: 'journey', visibility: 'exported', contract: 'Release journey.' }],
      imports: [{ fromNodeId: 'V2.1', interfaceId: 'v2-1-journey', purpose: 'entry/progression checkpoint' }],
    });
    contract(root, 'milestone', 'V2.1', {
      interfaces: [{ id: 'v2-1-journey', type: 'journey', visibility: 'exported', contract: 'New game through save/continue.' }],
      featureUses: [
        { featureId: 'entry', interfaceId: 'new-game', purpose: 'start from real UI' },
        { featureId: 'progression', interfaceId: 'equip-persist', purpose: 'verify persistence' },
      ],
      integrationScenarios: [{
        id: 'entry-progression',
        description: 'New Game -> equip -> save -> continue.',
        uses: [],
      }],
      integrationTasks: [{
        id: 'v2-1-e2e',
        title: 'Verify V2.1',
        intent: 'Exercise the V2.1 integration journey.',
        acceptanceCriteria: ['Journey succeeds.'],
        testStrategy: 'Tester-authored UI E2E.',
        verification: [],
        interfaceIds: ['v2-1-journey'],
      }],
    });

    const dev = buildRoleBoundaryContext({
      artifactRoot: root,
      role: 'developer',
      task: { logicalRefs: ['entry'], milestoneId: 'V2.1', interfaceIds: ['new-game'] },
      workspace: root,
    });
    assert.equal(dev.features.length, 1);
    assert.equal(dev.features[0].id, 'entry');
    assert.deepEqual(dev.features[0].interfaces.map(x => x.id), ['new-game']);
    assert.equal(dev.features[0].interfaces[0].binding.realization[0].resolved.snippet.some(x => x.text.includes('func new_game')), true);
    assert.equal(JSON.stringify(dev).includes('internal_load'), false);
    assert.equal(JSON.stringify(dev).includes('battle'), false);
    assert.equal(JSON.stringify(dev).includes('equip-persist'), false);
    assert.equal(dev.parentExpectations[0].featureId, 'srpg');

    const tester = buildRoleBoundaryContext({
      artifactRoot: root,
      role: 'tester',
      task: { milestoneId: 'V2.1', logicalRefs: ['entry', 'progression'] },
      workspace: root,
    });
    assert.deepEqual(tester.milestones.map(x => x.id), ['V2.1']);
    assert.deepEqual(tester.featureInterfaces.map(x => x.id).sort(), ['entry', 'progression']);
    assert.equal(
      tester.featureInterfaces.find(x => x.id === 'entry').interfaces.some(x => x.id === 'load-save-internal'),
      false,
    );
    assert.equal(JSON.stringify(tester).includes('load-save-internal'), false);
    assert.equal(JSON.stringify(tester).includes('entry-progression'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
