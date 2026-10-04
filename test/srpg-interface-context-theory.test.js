import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureInterfaceArtifactLayout } from '../src/v2/interface-contracts.js';
import { buildRoleBoundaryContext } from '../src/v2/role-boundary-context.js';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function json(file, value) {
  write(file, JSON.stringify(value, null, 2) + '\n');
}

function feature(root, id, parentId) {
  json(path.join(root, '.ariad', 'artifacts', 'planner', 'logical', `${id}.json`), {
    id, title: id, summary: `${id} summary`, parentId,
  });
}

function milestone(root, id, parentId) {
  json(path.join(root, '.ariad', 'artifacts', 'planner', 'milestones', `${id}.json`), {
    id, title: id, goal: `${id} goal`, parentId,
    dependsOn: [], logicalRefs: [], acceptanceCriteria: [`${id} accepted`],
    testStrategy: `${id} integration`, tasks: [],
  });
}

function contract(artifactRoot, nodeType, id, value) {
  const layout = ensureInterfaceArtifactLayout(artifactRoot);
  const dir = nodeType === 'feature' ? layout.featureDir : layout.milestoneDir;
  json(path.join(dir, `${id}.json`), {
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
    ...value,
  });
}

test('SRPG interface graph preloads bounded code and excludes unrelated repo-scale discovery', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-srpg-theory-'));
  const artifactRoot = path.join(workspace, '.ariad', 'artifacts');
  try {
    write(path.join(workspace, 'scripts', 'autoload', 'game_state.gd'), [
      'extends Node',
      '',
      'func new_game() -> void:',
      '\treset_dev_state()',
      '',
      'func map_unlocked(map_id: String) -> bool:',
      '\treturn map_id == "map_01"',
      '',
      'func record_victory(map_id: String) -> void:',
      '\tpass',
      '',
    ].join('\n'));
    write(path.join(workspace, 'scripts', 'ui', 'title.gd'), [
      'extends Control',
      '',
      'func _on_new_game() -> void:',
      '\tGameState.new_game()',
      '',
    ].join('\n'));
    write(path.join(workspace, 'scripts', 'ui', 'progression.gd'), [
      'extends Control',
      '',
      'func equip_persist() -> void:',
      '\tGameState.save_game()',
      '',
    ].join('\n'));

    // Deliberately large unrelated surfaces that the old discovery-first agent
    // would be tempted to scan.
    write(path.join(workspace, 'scripts', 'battle', 'battle.gd'),
      Array.from({ length: 1800 }, (_, i) => `# unrelated battle line ${i + 1}`).join('\n'));
    for (let i = 1; i <= 20; i += 1) {
      json(path.join(workspace, 'data', 'maps', `map_${String(i).padStart(2, '0')}.json`), {
        id: i,
        victory: 'rout_enemy',
      });
    }

    feature(workspace, 'srpg', null);
    feature(workspace, 'entry', 'srpg');
    feature(workspace, 'chapter_progression', 'srpg');
    feature(workspace, 'progression', 'srpg');

    contract(artifactRoot, 'feature', 'srpg', {
      decomposition: { kind: 'expand', reason: 'product capabilities' },
      interfaces: [{ id: 'playable', type: 'journey', visibility: 'exported', contract: 'Playable product.' }],
      imports: [
        { fromNodeId: 'entry', interfaceId: 'new-game', purpose: 'start journey' },
        { fromNodeId: 'chapter_progression', interfaceId: 'chapter-unlock', purpose: 'advance journey' },
        { fromNodeId: 'progression', interfaceId: 'equip-persist', purpose: 'persist equipment' },
      ],
    });
    contract(artifactRoot, 'feature', 'entry', {
      interfaces: [{ id: 'new-game', type: 'ui', visibility: 'exported', contract: 'Start clean game from title.' }],
      bindings: [{
        interfaceId: 'new-game',
        realizationAnchors: [
          { kind: 'symbol', file: 'scripts/autoload/game_state.gd', symbol: 'new_game', status: 'VALID' },
          { kind: 'symbol', file: 'scripts/ui/title.gd', symbol: '_on_new_game', status: 'VALID' },
        ],
        verificationAnchors: [],
      }],
    });
    contract(artifactRoot, 'feature', 'chapter_progression', {
      interfaces: [{ id: 'chapter-unlock', type: 'service', visibility: 'exported', contract: 'Victory unlocks only valid next chapter.' }],
      bindings: [{
        interfaceId: 'chapter-unlock',
        realizationAnchors: [
          { kind: 'symbol', file: 'scripts/autoload/game_state.gd', symbol: 'map_unlocked', status: 'VALID' },
          { kind: 'symbol', file: 'scripts/autoload/game_state.gd', symbol: 'record_victory', status: 'VALID' },
        ],
        verificationAnchors: [],
      }],
    });
    contract(artifactRoot, 'feature', 'progression', {
      interfaces: [{ id: 'equip-persist', type: 'journey', visibility: 'exported', contract: 'Equipment persists through save/continue.' }],
      bindings: [{
        interfaceId: 'equip-persist',
        realizationAnchors: [
          { kind: 'symbol', file: 'scripts/ui/progression.gd', symbol: 'equip_persist', status: 'VALID' },
        ],
        verificationAnchors: [],
      }],
    });

    milestone(workspace, 'V2', null);
    milestone(workspace, 'V2.1', 'V2');
    contract(artifactRoot, 'milestone', 'V2', {
      decomposition: { kind: 'expand', reason: 'delivery hierarchy' },
      interfaces: [{ id: 'release', type: 'journey', visibility: 'exported', contract: 'V2 release.' }],
      imports: [{ fromNodeId: 'V2.1', interfaceId: 'entry-progression', purpose: 'integrate V2.1' }],
    });
    contract(artifactRoot, 'milestone', 'V2.1', {
      interfaces: [{ id: 'entry-progression', type: 'journey', visibility: 'exported', contract: 'New game to persisted progression.' }],
      featureUses: [
        { featureId: 'entry', interfaceId: 'new-game', purpose: 'start' },
        { featureId: 'chapter_progression', interfaceId: 'chapter-unlock', purpose: 'advance' },
        { featureId: 'progression', interfaceId: 'equip-persist', purpose: 'persist' },
      ],
      integrationScenarios: [{
        id: 'v2-1-journey',
        description: 'New Game -> victory -> unlock -> equip -> save/continue.',
        uses: [
          { graph: 'feature', nodeId: 'entry', interfaceId: 'new-game' },
          { graph: 'feature', nodeId: 'chapter_progression', interfaceId: 'chapter-unlock' },
          { graph: 'feature', nodeId: 'progression', interfaceId: 'equip-persist' },
        ],
      }],
    });

    const context = buildRoleBoundaryContext({
      artifactRoot,
      workspace,
      role: 'tester',
      task: {
        milestoneId: 'V2.1',
        logicalRefs: ['entry', 'chapter_progression', 'progression'],
      },
    });
    const serialized = JSON.stringify(context);

    assert.equal(serialized.includes('func new_game'), true);
    assert.equal(serialized.includes('func map_unlocked'), true);
    assert.equal(serialized.includes('func record_victory'), true);
    assert.equal(serialized.includes('func equip_persist'), true);

    assert.equal(serialized.includes('unrelated battle line'), false);
    assert.equal(serialized.includes('map_01.json'), false);
    assert.equal(serialized.includes('map_20.json'), false);

    const snippets = context.featureInterfaces.flatMap(featureEntry =>
      featureEntry.interfaces.flatMap(iface =>
        (iface.binding?.realization ?? []).flatMap(anchor => anchor.resolved?.snippet ?? [])
      )
    );
    assert.ok(snippets.length < 80, `expected bounded context, got ${snippets.length} lines`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
