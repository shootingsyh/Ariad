import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryInterfaces } from '../src/v2/interface-query.js';

function contract({ nodeId, nodeType, interfaces = [], imports = [] }) {
  return {
    version: 1,
    nodeId,
    nodeType,
    decomposition: { kind: 'leaf', reason: 'test fixture' },
    interfaces,
    imports,
    integrationScenarios: [],
  };
}

function executorIface(id) {
  return {
    id,
    kind: 'executor',
    visibility: 'exported',
    contract: { input: ['in'], output: ['out'], sideEffects: [] },
    verificationSketch: 'fixture verification',
  };
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ariad-interface-query-'));
  const features = join(root, 'planner', 'interfaces', 'features');
  const milestones = join(root, 'planner', 'interfaces', 'milestones');
  mkdirSync(features, { recursive: true });
  mkdirSync(milestones, { recursive: true });
  writeFileSync(join(features, 'alpha.json'), JSON.stringify(contract({
    nodeId: 'alpha',
    nodeType: 'feature',
    interfaces: [executorIface('alpha-service')],
  })));
  writeFileSync(join(features, 'beta.json'), JSON.stringify(contract({
    nodeId: 'beta',
    nodeType: 'feature',
    interfaces: [executorIface('beta-view')],
    imports: [{ fromNodeId: 'alpha', interfaceId: 'alpha-service', purpose: 'render alpha data' }],
  })));
  writeFileSync(join(milestones, 'release.json'), JSON.stringify(contract({
    nodeId: 'release',
    nodeType: 'milestone',
    interfaces: [executorIface('release-acceptance')],
    imports: [{ fromNodeId: 'alpha', interfaceId: 'alpha-service', purpose: 'accept alpha end to end' }],
  })));
  return root;
}

test('lists every interface across features and milestones, sorted by id', () => {
  const { count, interfaces } = queryInterfaces(fixtureRoot());
  assert.equal(count, 3);
  assert.deepEqual(interfaces.map(i => i.interfaceId), ['alpha-service', 'beta-view', 'release-acceptance']);
  const alpha = interfaces[0];
  assert.equal(alpha.nodeId, 'alpha');
  assert.equal(alpha.nodeType, 'feature');
  assert.equal(alpha.kind, 'executor');
  assert.deepEqual(alpha.contract, { input: ['in'], output: ['out'], sideEffects: [] });
});

test('resolves one interface by id with its importers', () => {
  const { count, interfaces } = queryInterfaces(fixtureRoot(), { interfaceId: 'alpha-service' });
  assert.equal(count, 1);
  assert.equal(interfaces[0].interfaceId, 'alpha-service');
  assert.deepEqual(
    interfaces[0].importedBy.map(i => i.nodeId).sort(),
    ['beta', 'release'],
  );
  const betaImport = interfaces[0].importedBy.find(i => i.nodeId === 'beta');
  assert.equal(betaImport.fromNodeId, 'alpha');
  assert.equal(betaImport.purpose, 'render alpha data');
});

test('milestone interfaces carry nodeType milestone', () => {
  const { interfaces } = queryInterfaces(fixtureRoot(), { interfaceId: 'release-acceptance' });
  assert.equal(interfaces[0].nodeType, 'milestone');
  assert.equal(interfaces[0].nodeId, 'release');
});

test('unknown interface id is an error, not an empty result', () => {
  assert.throws(() => queryInterfaces(fixtureRoot(), { interfaceId: 'nope' }), /unknown interface id: nope/);
});

test('a project with no planner artifacts resolves to an empty list', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-interface-query-empty-'));
  const { count, interfaces } = queryInterfaces(root);
  assert.equal(count, 0);
  assert.deepEqual(interfaces, []);
});
