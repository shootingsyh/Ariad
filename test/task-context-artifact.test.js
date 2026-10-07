import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskContextArtifact } from '../src/runtime/task-context-artifact.js';

const bound = (kind, file, snippet) => ({
  anchor: { kind: 'range', file, startLine: 1, endLine: 2 },
  resolved: { fileHash: 'abc', range: { startLine: 1, endLine: 2 }, snippet, resolver: 'static-preload' },
});

test('task context artifact deduplicates contracts, strips source snippets, and keeps ordered role slots', () => {
  const boundaryContext = {
    principle: 'shared',
    owningFeatures: [{
      id: 'F1', title: 'Owner', interfaces: [{
        id: 'I1', contract: { input: {}, output: {} },
        binding: {
          realization: [bound('realization', 'src/a.gd', ['secret source line'])],
          verification: [bound('verification', 'tests/a.gd', ['large test source'])],
        },
      }],
    }],
    referencedFeatureInterfaces: [
      { id: 'F1', title: 'duplicate owner', interfaces: [{ id: 'I1', binding: { realization: [] } }] },
      { id: 'F2', title: 'dependency', interfaces: [{ id: 'I2', contract: { input: {} }, binding: null }] },
    ],
    milestones: [{ id: 'M1' }],
    parentExpectations: [{ featureId: 'P1' }],
    milestoneUses: [{ milestoneId: 'M1', featureId: 'F1' }],
  };
  const task = {
    id: 'T1', title: 'Task', intent: 'do it', acceptanceCriteria: ['AC1'],
    interfaceIds: ['I1'], logicalRefs: ['F1'], milestoneId: 'M1',
    history: [
      { type: 'ROLE_RESULT', role: 'developer', outcome: 'PASS', summary: 'implemented', keyPoints: [], artifacts: [], result: { interfaceRealizations: [{ interfaceId: 'I1' }] } },
      { type: 'SYSTEM_INTERRUPTION', role: 'tester', failure: 'old transient failure' },
    ],
  };
  const artifact = buildTaskContextArtifact({ task, boundaryContext });
  assert.deepEqual(Object.keys(artifact), [
    'schema', 'task', 'contracts', 'dependencies', 'artist', 'developer', 'tester', 'reviewer', 'repair',
  ]);
  assert.deepEqual(artifact.contracts.referencedFeatureInterfaces.map(x => x.id), ['F2']);
  assert.equal('binding' in artifact.contracts.owningFeatures[0].interfaces[0], false);
  assert.equal(artifact.developer.interfaceRealizations.length, 1);
  assert.equal(artifact.developer.interfaceRealizations[0].anchors[0].resolved.fileHash, 'abc');
  assert.equal('snippet' in artifact.developer.interfaceRealizations[0].anchors[0].resolved, false);
  assert.equal(artifact.tester.interfaceVerifications.length, 1);
  assert.equal(artifact.reviewer, null);
  assert.equal(JSON.stringify(artifact).includes('secret source line'), false);
  assert.equal(JSON.stringify(artifact).includes('large test source'), false);
});

test('task artifact keeps stable fields before stage slots so later stages extend the cacheable prefix', () => {
  const boundaryContext = {
    principle: 'shared',
    owningFeatures: [{ id: 'F1', interfaces: [{ id: 'I1', contract: { input: {}, output: {} }, binding: null }] }],
    referencedFeatureInterfaces: [], milestones: [], parentExpectations: [], milestoneUses: [],
  };
  const base = { id: 'T2', title: 'Stable prefix', intent: 'x', acceptanceCriteria: ['AC1'], interfaceIds: ['I1'], logicalRefs: ['F1'], history: [] };
  const before = JSON.stringify(buildTaskContextArtifact({ task: base, boundaryContext }));
  const afterDeveloper = JSON.stringify(buildTaskContextArtifact({
    task: { ...base, history: [{ type: 'ROLE_RESULT', role: 'developer', outcome: 'PASS', summary: 'done', keyPoints: [], artifacts: [], result: {} }] },
    boundaryContext,
  }));
  const developerOffsetBefore = before.indexOf('"developer":');
  const developerOffsetAfter = afterDeveloper.indexOf('"developer":');
  assert.equal(before.slice(0, developerOffsetBefore), afterDeveloper.slice(0, developerOffsetAfter));
  assert.ok(developerOffsetBefore > before.indexOf('"contracts":'));
});
