import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginFrontierPass,
  ensureInterfaceArtifactLayout,
  finishFrontierPass,
  frontierPromptContext,
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
      kind: 'executor',
      visibility: 'exported',
      contract: { input: [], output: [`${id} contract`], sideEffects: [] },
    })),
    imports,
    integrationScenarios: scenarios,
  });
}


test('interface schema accepts executor/provider primitives and rejects legacy interface types', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-interface-primitives-'));
  try {
    feature(root, 'project', null);
    const layout = ensureInterfaceArtifactLayout(root);
    writeJson(path.join(layout.featureDir, 'project.json'), {
      version: 1,
      nodeId: 'project',
      nodeType: 'feature',
      decomposition: { kind: 'leaf', reason: 'bounded primitive schema test' },
      interfaces: [
        {
          id: 'run',
          kind: 'executor',
          visibility: 'exported',
          contract: {
            input: 'request',
            output: ['result'],
            sideEffects: [],
          },
        },
        {
          id: 'surface',
          kind: 'provider',
          visibility: 'exported',
          contract: {
            input: ['view state'],
            produces: {
              thing: 'interactive surface',
              input: ['select'],
              output: ['selection intent'],
              sideEffects: ['updates visible selection'],
            },
          },
        },
      ],
      imports: [],
      integrationScenarios: [],
      bindings: [],
      featureTasks: [],
    });

    assert.equal(validateBoundaryContracts(root, 'feature', { allowFrontier: false }).ok, true);

    const raw = JSON.parse(fs.readFileSync(path.join(layout.featureDir, 'project.json'), 'utf8'));
    raw.interfaces[0] = {
      id: 'run',
      type: 'service',
      visibility: 'exported',
      contract: 'legacy contract',
    };
    writeJson(path.join(layout.featureDir, 'project.json'), raw);
    assert.throws(
      () => validateBoundaryContracts(root, 'feature', { allowFrontier: false }),
      /unexpected|executor\|provider/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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


test('version migration planning gives one frontier up to three critic rounds before debugger', () => {
  const tasks = plannerFlowTasks('batch-migrate', [{
    request: { purpose: 'VERSION_MIGRATION', frontierPhase: 'feature' },
  }]);

  assert.deepEqual(
    tasks.map(task => task.input?.purpose),
    [
      'PLANNER_DECOMPOSE',
      'PLANNER_FRONTIER_VALIDATE',
      'PLANNER_FRONTIER_CRITIC',
      'PLANNER_FRONTIER_REPAIR',
      'PLANNER_FRONTIER_VALIDATE',
      'PLANNER_FRONTIER_CRITIC',
      'PLANNER_FRONTIER_REPAIR',
      'PLANNER_FRONTIER_VALIDATE',
      'PLANNER_FRONTIER_CRITIC',
      'PLANNER_FRONTIER_DEBUG',
      'PLANNER_FRONTIER_FINALIZE',
    ],
  );
  assert.equal(tasks[0].input.singleFrontier, true);
  assert.equal(tasks[0].input.frontierPhase, 'feature');
  assert.deepEqual(
    tasks.filter(task => task.input?.purpose === 'PLANNER_FRONTIER_CRITIC').map(task => task.input.round),
    [1, 2, 3],
  );
  assert.deepEqual(
    tasks.filter(task => task.input?.purpose === 'PLANNER_FRONTIER_VALIDATE').map(task => task.input.round),
    [1, 2, 3],
  );
  assert.equal(tasks.find(task => task.input?.purpose === 'PLANNER_FRONTIER_DEBUG').stage, 'project_debugger');
  assert.deepEqual(
    tasks.at(-1).dependsOn,
    [
      'planner:batch-migrate:frontier-critic-1',
      'planner:batch-migrate:frontier-critic-2',
      'planner:batch-migrate:frontier-critic-3',
      'planner:batch-migrate:frontier-debugger',
    ],
  );
});

test('version migration finalization compiles the frozen tree before PM review', () => {
  const tasks = plannerFlowTasks('batch-finalize', [{
    request: { purpose: 'VERSION_MIGRATION_FINALIZE' },
  }]);
  assert.deepEqual(
    tasks.map(task => task.input?.purpose),
    [
      'PLANNER_DEPENDENCIES',
      'PLANNER_VALIDATE',
      'PLANNER_CRITIC',
      'PLANNER_REPAIR',
      'PLANNER_FINAL_VALIDATE',
      'PLANNER_PM_REVIEW',
    ],
  );
  assert.equal(tasks[0].input.versionMigration, true);
  assert.equal(tasks.at(-1).input.versionMigration, true);
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


test('migration frontier preserves archived grandchildren and validates the durable target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-frontier-legacy-'));
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-frontier-archive-'));
  try {
    for (const dir of [root, legacy]) {
      feature(dir, 'project', null);
      feature(dir, 'release', 'project');
      feature(dir, 'platform', 'release');
    }
    contract(root, 'feature', 'project', { decomposition: 'expand', exports: ['project-api'] });
    contract(root, 'feature', 'release', { decomposition: 'expand', exports: ['release-api'] });
    contract(root, 'feature', 'platform', { decomposition: 'leaf', exports: ['platform-api'] });

    // Legacy active-frontier artifacts predate the node-baseline field and may
    // point to null even though the durable migration decision targets release.
    writeJson(path.join(root, 'planner', 'interfaces', 'active-frontier.json'), {
      version: 1, nodeType: 'feature', bootstrap: false, targetNodeId: null,
    });
    const pass = finishFrontierPass(root, 'feature', {
      expectedTargetNodeId: 'release',
      legacyBaselineRoot: legacy,
    });
    assert.equal(pass.targetNodeId, 'release');
    assert.deepEqual(pass.childIds, ['platform']);
    assert.throws(
      () => finishFrontierPass(root, 'feature'),
      /one-layer frontier pass illegally created grandchild/,
    );

    feature(root, 'surprise', 'platform');
    contract(root, 'feature', 'platform', { decomposition: 'expand', exports: ['platform-api'] });
    contract(root, 'feature', 'surprise', { decomposition: 'leaf', exports: ['surprise-api'] });
    assert.throws(
      () => finishFrontierPass(root, 'feature', {
        expectedTargetNodeId: 'release',
        legacyBaselineRoot: legacy,
      }),
      /one-layer frontier pass illegally created grandchild/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(legacy, { recursive: true, force: true });
  }
});

test('frontier pass allows pre-existing grandchildren but rejects newly introduced ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-frontier-existing-'));
  try {
    feature(root, 'project', null);
    feature(root, 'child', 'project');
    feature(root, 'old-descendant', 'child');
    contract(root, 'feature', 'project', { decomposition: 'expand', exports: ['project-api'] });
    contract(root, 'feature', 'child', { decomposition: 'expand', exports: ['child-api'] });
    contract(root, 'feature', 'old-descendant', { decomposition: 'leaf', exports: ['old-api'] });
    beginFrontierPass(root, 'feature');
    const ok = finishFrontierPass(root, 'feature');
    assert.equal(ok.targetNodeId, 'project');

    feature(root, 'new-descendant', 'child');
    contract(root, 'feature', 'new-descendant', { decomposition: 'leaf', exports: ['new-api'] });
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
        kind: 'executor', visibility: 'exported', contract: { input: [], output: ['Player can start the supported journey.'], sideEffects: [] },
      }],
      imports: [],
      featureUses: [{
        featureId: 'project',
        interfaceId: 'new-game',
        purpose: 'Start from the product entry contract.',
      }],
      integrationScenarios: [{
        id: 'start-product',
        description: 'Milestone verifies the product entry interface.',
        uses: [{ graph: 'feature', nodeId: 'project', interfaceId: 'new-game' }],
      }],
      taskLinks: [],
      integrationTasks: [],
    });

    assert.equal(
      validateBoundaryContracts(root, 'milestone', { allowFrontier: false }).ok,
      true,
    );

    const undeclared = JSON.parse(fs.readFileSync(path.join(layout.milestoneDir, 'M0.json'), 'utf8'));
    undeclared.featureUses = [];
    writeJson(path.join(layout.milestoneDir, 'M0.json'), undeclared);
    assert.throws(
      () => validateBoundaryContracts(root, 'milestone', { allowFrontier: false }),
      /scenario start-product uses unavailable interface feature:project\/new-game/,
    );

    const bad = JSON.parse(fs.readFileSync(path.join(layout.milestoneDir, 'M0.json'), 'utf8'));
    bad.featureUses = [{
      featureId: 'project',
      interfaceId: 'not-exported',
      purpose: 'Bad reference for validation.',
    }];
    bad.integrationScenarios = [];

    writeJson(path.join(layout.milestoneDir, 'M0.json'), bad);
    assert.throws(
      () => validateBoundaryContracts(root, 'milestone', { allowFrontier: false }),
      /feature interface project\/not-exported is not exported/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('existing one-layer hierarchy with no contracts enters contract bootstrap instead of failing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-frontier-contract-bootstrap-'));
  try {
    const logical = path.join(root, 'planner', 'logical');
    fs.mkdirSync(logical, { recursive: true });
    fs.writeFileSync(path.join(logical, 'root.json'), JSON.stringify({
      id: 'root', title: 'Root', summary: 'Existing root', parentId: null,
    }, null, 2));
    fs.writeFileSync(path.join(logical, 'child.json'), JSON.stringify({
      id: 'child', title: 'Child', summary: 'Existing child', parentId: 'root',
    }, null, 2));

    const frontier = nextBoundaryFrontier(root, 'feature');
    assert.equal(frontier.bootstrap, true);
    assert.equal(frontier.contractBootstrap, true);
    assert.equal(frontier.node.id, 'root');
    assert.deepEqual(frontier.directChildren.map(node => node.id), ['child']);

    const context = frontierPromptContext(root, 'feature');
    assert.equal(context.contractBootstrap, true);
    assert.match(context.instruction, /already materialized/);
    assert.match(context.instruction, /Do not recreate or rename/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
