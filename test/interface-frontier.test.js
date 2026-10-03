import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginFrontierPass,
  ensureInterfaceArtifactLayout,
  finishFrontierPass,
  nextBoundaryFrontier,
  validateBoundaryContracts,
} from '../src/v2/interface-contracts.js';
import { plannerFlowTasks } from '../src/v2/planner-flow.js';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function feature(root, id, parentId, summary = id) {
  writeJson(path.join(root, 'planner', 'logical', `${id}.json`), {
    id, title: id, summary, parentId,
  });
}

function milestone(root, id, parentId) {
  writeJson(path.join(root, 'planner', 'milestones', `${id}.json`), {
    id,
    title: id,
    goal: `Goal for ${id}`,
    parentId,
    dependsOn: [],
    logicalRefs: ['project'],
    acceptanceCriteria: [`${id} works`],
    testStrategy: `Test ${id} boundary`,
    tasks: [],
  });
}

function contract(root, nodeType, nodeId, {
  decomposition = 'leaf',
  exports = [],
  imports = [],
  scenarios = [],
} = {}) {
  const layout = ensureInterfaceArtifactLayout(root);
  const dir = nodeType === 'feature' ? layout.featureDir : layout.milestoneDir;
  writeJson(path.join(dir, `${nodeId}.json`), {
    version: 1,
    nodeId,
    nodeType,
    decomposition: { kind: decomposition, reason: `${decomposition} ${nodeId}` },
    interfaces: exports.map(id => ({
      id,
      type: 'service',
      visibility: 'exported',
      contract: `${id} contract`,
    })),
    imports,
    integrationScenarios: scenarios,
  });
}

test('planner flow keeps one iterative decompose task before dependency planning', () => {
  const tasks = plannerFlowTasks('batch-1', []);
  const decompose = tasks.find(task => task.input?.purpose === 'PLANNER_DECOMPOSE');
  const dependencies = tasks.find(task => task.input?.purpose === 'PLANNER_DEPENDENCIES');
  assert.ok(decompose);
  assert.ok(dependencies);
  assert.deepEqual(dependencies.dependsOn, [decompose.id]);
  assert.equal(tasks.some(task => task.input?.purpose === 'PLANNER_FEATURE_INTERFACES'), false);
  assert.equal(tasks.some(task => task.input?.purpose === 'PLANNER_MILESTONE_INTERFACES'), false);
});

test('top-down feature frontier selects BFS first expandable leaf and expands one layer only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-frontier-'));
  try {
    const first = beginFrontierPass(root, 'feature');
    assert.equal(first.bootstrap, true);

    feature(root, 'project', null);
    feature(root, 'alpha', 'project');
    feature(root, 'beta', 'project');
    contract(root, 'feature', 'project', {
      decomposition: 'expand',
      exports: ['project-run'],
      imports: [
        { fromNodeId: 'alpha', interfaceId: 'alpha-api', purpose: 'compose alpha' },
        { fromNodeId: 'beta', interfaceId: 'beta-api', purpose: 'compose beta' },
      ],
      scenarios: [{
        id: 'project-flow',
        description: 'Compose alpha and beta',
        uses: [
          { nodeId: 'alpha', interfaceId: 'alpha-api' },
          { nodeId: 'beta', interfaceId: 'beta-api' },
        ],
      }],
    });
    contract(root, 'feature', 'alpha', { decomposition: 'expand', exports: ['alpha-api'] });
    contract(root, 'feature', 'beta', { decomposition: 'leaf', exports: ['beta-api'] });

    const afterRoot = finishFrontierPass(root, 'feature');
    assert.deepEqual(afterRoot.childIds, ['alpha', 'beta']);
    assert.equal(afterRoot.next.node.id, 'alpha');

    const second = beginFrontierPass(root, 'feature');
    assert.equal(second.current.node.id, 'alpha');

    feature(root, 'alpha-one', 'alpha');
    feature(root, 'alpha-two', 'alpha');
    contract(root, 'feature', 'alpha-one', { decomposition: 'leaf', exports: ['one-api'] });
    contract(root, 'feature', 'alpha-two', { decomposition: 'leaf', exports: ['two-api'] });
    contract(root, 'feature', 'alpha', {
      decomposition: 'expand',
      exports: ['alpha-api'],
      imports: [
        { fromNodeId: 'alpha-one', interfaceId: 'one-api', purpose: 'one' },
        { fromNodeId: 'alpha-two', interfaceId: 'two-api', purpose: 'two' },
      ],
      scenarios: [{
        id: 'alpha-flow',
        description: 'Compose alpha children',
        uses: [
          { nodeId: 'alpha-one', interfaceId: 'one-api' },
          { nodeId: 'alpha-two', interfaceId: 'two-api' },
        ],
      }],
    });

    const afterAlpha = finishFrontierPass(root, 'feature');
    assert.equal(afterAlpha.next, null);
    assert.equal(validateBoundaryContracts(root, 'feature', { allowFrontier: false }).complete, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontier pass rejects grandchildren created in the same TL round', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-frontier-depth-'));
  try {
    beginFrontierPass(root, 'feature');
    feature(root, 'project', null);
    feature(root, 'child', 'project');
    feature(root, 'grandchild', 'child');
    contract(root, 'feature', 'project', {
      decomposition: 'expand',
      exports: ['project-api'],
      imports: [{ fromNodeId: 'child', interfaceId: 'child-api', purpose: 'child' }],
    });
    contract(root, 'feature', 'child', {
      decomposition: 'expand',
      exports: ['child-api'],
      imports: [{ fromNodeId: 'grandchild', interfaceId: 'grand-api', purpose: 'grand' }],
    });
    contract(root, 'feature', 'grandchild', { decomposition: 'leaf', exports: ['grand-api'] });

    assert.throws(
      () => finishFrontierPass(root, 'feature'),
      /one-layer frontier pass illegally created grandchild/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parent-facing exported interfaces freeze when a child is first exposed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-frontier-freeze-'));
  try {
    beginFrontierPass(root, 'feature');
    feature(root, 'project', null);
    feature(root, 'child', 'project');
    contract(root, 'feature', 'project', {
      decomposition: 'expand',
      exports: ['project-api'],
      imports: [{ fromNodeId: 'child', interfaceId: 'child-api', purpose: 'child' }],
    });
    contract(root, 'feature', 'child', { decomposition: 'expand', exports: ['child-api'] });
    finishFrontierPass(root, 'feature');

    beginFrontierPass(root, 'feature');
    feature(root, 'leaf', 'child');
    contract(root, 'feature', 'leaf', { decomposition: 'leaf', exports: ['leaf-api'] });
    contract(root, 'feature', 'child', {
      decomposition: 'expand',
      exports: ['renamed-child-api'],
      imports: [{ fromNodeId: 'leaf', interfaceId: 'leaf-api', purpose: 'leaf' }],
    });

    assert.throws(
      () => finishFrontierPass(root, 'feature'),
      /exported interface changed after it was exposed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('milestone frontier uses the same top-down contract discipline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-milestone-frontier-'));
  try {
    feature(root, 'project', null);
    const first = beginFrontierPass(root, 'milestone');
    assert.equal(first.bootstrap, true);

    milestone(root, 'M0', null);
    milestone(root, 'M1', 'M0');
    contract(root, 'milestone', 'M0', {
      decomposition: 'expand',
      exports: ['project-journey'],
      imports: [{ fromNodeId: 'M1', interfaceId: 'm1-journey', purpose: 'compose M1' }],
    });
    contract(root, 'milestone', 'M1', {
      decomposition: 'leaf',
      exports: ['m1-journey'],
    });

    const pass = finishFrontierPass(root, 'milestone');
    assert.equal(pass.next, null);
    assert.equal(nextBoundaryFrontier(root, 'milestone'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('milestone may consume exported feature interfaces but not feature internals or unknown interfaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-feature-use-'));
  try {
    feature(root, 'project', null);
    contract(root, 'feature', 'project', {
      decomposition: 'leaf',
      exports: ['new-game'],
    });

    milestone(root, 'M0', null);
    const layout = ensureInterfaceArtifactLayout(root);
    writeJson(path.join(layout.milestoneDir, 'M0.json'), {
      version: 1,
      nodeId: 'M0',
      nodeType: 'milestone',
      decomposition: { kind: 'leaf', reason: 'single integration boundary' },
      interfaces: [{
        id: 'm0-journey',
        type: 'journey',
        visibility: 'exported',
        contract: 'Player can start the supported journey.',
      }],
      imports: [],
      featureUses: [{
        featureId: 'project',
        interfaceId: 'new-game',
        purpose: 'Start from the product entry contract.',
      }],
      integrationScenarios: [],
      taskLinks: [],
      integrationTasks: [],
    });

    assert.equal(
      validateBoundaryContracts(root, 'milestone', { allowFrontier: false }).ok,
      true,
    );

    const bad = JSON.parse(fs.readFileSync(path.join(layout.milestoneDir, 'M0.json'), 'utf8'));
    bad.featureUses[0].interfaceId = 'not-exported';
    writeJson(path.join(layout.milestoneDir, 'M0.json'), bad);
    assert.throws(
      () => validateBoundaryContracts(root, 'milestone', { allowFrontier: false }),
      /feature interface project\/not-exported is not exported/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
