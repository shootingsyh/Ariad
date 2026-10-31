import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureInterfaceArtifactLayout,
  loadBoundaryContracts,
  validateBoundaryContracts,
  validateFrontierPass,
} from '../src/v2/interface-contracts.js';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function feature(root, id, parentId) {
  writeJson(path.join(root, 'planner', 'logical', `${id}.json`), {
    id, title: id, summary: id, parentId,
  });
}

function featureContract(root, nodeId, {
  decomposition = 'leaf',
  exports = ['run'],
  imports = [],
  scenarios = [],
  behavior,
} = {}) {
  const layout = ensureInterfaceArtifactLayout(root);
  const doc = {
    version: 1,
    nodeId,
    nodeType: 'feature',
    decomposition: { kind: decomposition, reason: `${decomposition} ${nodeId}` },
    interfaces: exports.map(id => ({
      id,
      kind: 'executor',
      visibility: 'exported',
      contract: { input: [], output: [`${id} result`], sideEffects: [] },
    })),
    imports,
    integrationScenarios: scenarios,
    bindings: [],
    featureTasks: [],
  };
  if (behavior !== undefined) doc.behavior = behavior;
  writeJson(path.join(layout.featureDir, `${nodeId}.json`), doc);
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-behavior-layer-'));
}

test('leaf feature behavior clauses load and normalize', () => {
  const root = tempRoot();
  feature(root, 'project', null);
  featureContract(root, 'project', {
    behavior: ['  Given a selected unit, attack requires a prior move in the same turn.  '],
  });
  const contracts = loadBoundaryContracts(root, 'feature');
  assert.deepEqual(contracts.get('project').behavior, [
    'Given a selected unit, attack requires a prior move in the same turn.',
  ]);
});

test('behavior clauses must be non-empty strings', () => {
  const root = tempRoot();
  feature(root, 'project', null);
  featureContract(root, 'project', { behavior: ['   '] });
  assert.throws(() => loadBoundaryContracts(root, 'feature'), /behavior\[0\]: non-empty string required/);
});

test('stored leaf without behavior still validates globally (no retroactive judgement)', () => {
  const root = tempRoot();
  feature(root, 'project', null);
  featureContract(root, 'project', {});
  assert.equal(validateBoundaryContracts(root, 'feature', { allowFrontier: false }).ok, true);
});

test('per-node validation requires behavior on a leaf feature', () => {
  const root = tempRoot();
  feature(root, 'project', null);
  featureContract(root, 'project', {});
  assert.throws(
    () => validateBoundaryContracts(root, 'feature', { targetNodeId: 'project' }),
    /leaf feature requires behavior clauses/,
  );
  featureContract(root, 'project', { behavior: ['A clause.'] });
  assert.equal(validateBoundaryContracts(root, 'feature', { targetNodeId: 'project' }).ok, true);
});

test('requireBehaviorFor scopes the gate to named nodes only', () => {
  const root = tempRoot();
  feature(root, 'project', null);
  featureContract(root, 'project', {});
  assert.throws(
    () => validateBoundaryContracts(root, 'feature', { requireBehaviorFor: ['project'] }),
    /leaf feature requires behavior clauses/,
  );
  assert.equal(
    validateBoundaryContracts(root, 'feature', { requireBehaviorFor: ['someone-else'] }).ok,
    true,
  );
});

test('frontier pass on a leaf requires behavior', () => {
  const root = tempRoot();
  feature(root, 'project', null);
  featureContract(root, 'project', {});
  assert.throws(() => validateFrontierPass(root, 'feature'), /leaf feature requires behavior clauses/);
  featureContract(root, 'project', { behavior: ['A clause.'] });
  assert.equal(validateFrontierPass(root, 'feature').targetNodeId, 'project');
});

test('integration scenarios require acceptanceCriteria at the frontier', () => {
  const root = tempRoot();
  feature(root, 'project', null);
  feature(root, 'project.child', 'project');
  featureContract(root, 'project.child', { behavior: ['Child clause.'] });
  featureContract(root, 'project', {
    decomposition: 'expand',
    exports: [],
    imports: [{ fromNodeId: 'project.child', interfaceId: 'run', purpose: 'run the child' }],
    scenarios: [{
      id: 'happy-path',
      description: 'Child runs through the parent.',
      uses: [{ graph: 'feature', nodeId: 'project.child', interfaceId: 'run' }],
    }],
  });
  assert.throws(() => validateFrontierPass(root, 'feature'), /scenario happy-path requires acceptanceCriteria/);

  featureContract(root, 'project', {
    decomposition: 'expand',
    exports: [],
    imports: [{ fromNodeId: 'project.child', interfaceId: 'run', purpose: 'run the child' }],
    scenarios: [{
      id: 'happy-path',
      description: 'Child runs through the parent.',
      uses: [{ graph: 'feature', nodeId: 'project.child', interfaceId: 'run' }],
      acceptanceCriteria: ['The child result is visible at the parent boundary.'],
      invariants: ['The parent never calls the child twice for one request.'],
    }],
  });
  const contracts = loadBoundaryContracts(root, 'feature');
  assert.deepEqual(contracts.get('project').integrationScenarios[0].invariants, [
    'The parent never calls the child twice for one request.',
  ]);
  assert.equal(validateFrontierPass(root, 'feature').targetNodeId, 'project');
});

test('milestone contracts cannot carry behavior', () => {
  const root = tempRoot();
  writeJson(path.join(root, 'planner', 'milestones', 'M1.json'), {
    id: 'M1',
    title: 'M1',
    goal: 'Goal',
    parentId: null,
    dependsOn: [],
    logicalRefs: ['project'],
    acceptanceCriteria: ['M1 works'],
    testStrategy: 'Test M1',
    tasks: [],
  });
  const layout = ensureInterfaceArtifactLayout(root);
  writeJson(path.join(layout.milestoneDir, 'M1.json'), {
    version: 1,
    nodeId: 'M1',
    nodeType: 'milestone',
    decomposition: { kind: 'leaf', reason: 'single milestone' },
    interfaces: [],
    imports: [],
    integrationScenarios: [],
    behavior: ['Not allowed here.'],
  });
  assert.throws(() => loadBoundaryContracts(root, 'milestone'), /milestone contracts do not carry behavior/);
});
