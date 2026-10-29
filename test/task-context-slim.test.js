import test from 'node:test';
import assert from 'node:assert/strict';

import {
  slimTaskArtifactForPrompt,
  PROMPT_SLIM_THRESHOLD_BYTES,
} from '../src/runtime/task-context-artifact.js';
import { buildStandaloneRolePrompt } from '../src/runtime/role-run-prompt.js';

function fatBinding(featureId, interfaceId, file) {
  return {
    featureId,
    interfaceId,
    anchors: [{
      anchor: {
        kind: 'symbol', file, symbol: '_run', startLine: 155, startCharacter: 5,
        endLine: 155, endCharacter: 9, provider: 'godot-lsp',
        fileHash: 'a'.repeat(64), observedCommit: 'b'.repeat(40), status: 'VALID',
      },
      resolved: { fileHash: 'a'.repeat(64), range: { startLine: 155, endLine: 155 } },
    }],
  };
}

function fatArtifact() {
  const bindings = Array.from({ length: 10 }, (_, i) => fatBinding(`f${i}`, `iface-${i}`, `src/file-${i}.gd`));
  return {
    schema: 'ariad-task-context-v1',
    task: { id: 'T1', title: 'Big task', intent: 'do it', acceptanceCriteria: ['x'.repeat(200)] },
    contracts: {
      principle: 'p',
      referencedFeatureInterfaces: Array.from({ length: 8 }, (_, i) => ({
        id: `feat-${i}`, title: `Feature ${i}`, summary: 's'.repeat(900), decomposition: { kind: 'expand', reason: 'r'.repeat(300) },
      })),
      milestones: Array.from({ length: 6 }, (_, i) => ({ id: `m-${i}`, title: `Milestone ${i}`, description: 'd'.repeat(500) })),
    },
    developer: { summary: 'done', interfaceRealizations: bindings },
    tester: { summary: 'tested', interfaceVerifications: bindings },
    automatedRegression: {
      selection: 'all',
      tests: [
        ...Array.from({ length: 20 }, (_, i) => ({ test: `t-${i}.gd`, status: 'PASS', durationMs: 10 })),
        { test: 'bad.gd', status: 'FAIL', durationMs: 99, outputTail: 'boom' },
      ],
    },
  };
}

test('slimming collapses seal bookkeeping but keeps the working index and the task itself', () => {
  const artifact = fatArtifact();
  assert.ok(JSON.stringify(artifact).length > PROMPT_SLIM_THRESHOLD_BYTES);
  const slim = slimTaskArtifactForPrompt(artifact);

  assert.deepEqual(slim.task, artifact.task, 'the task block is never slimmed');
  const binding = slim.developer.interfaceRealizations[0];
  assert.equal(binding.interfaceId, 'iface-0');
  assert.deepEqual(binding.anchors, [{ kind: 'symbol', file: 'src/file-0.gd', symbol: '_run', startLine: 155 }]);
  const rendered = JSON.stringify(slim);
  assert.equal(rendered.includes('fileHash'), false);
  assert.equal(rendered.includes('resolved'), false);
  assert.deepEqual(slim.contracts.referencedFeatureInterfaces[0], { id: 'feat-0', title: 'Feature 0' });
  assert.deepEqual(slim.contracts.milestones[0], { id: 'm-0', title: 'Milestone 0' });
  assert.equal(slim.automatedRegression.tests, undefined);
  assert.deepEqual(slim.automatedRegression.testSummary, { total: 21, failed: 1 });
  assert.equal(slim.automatedRegression.failures[0].outputTail, 'boom', 'failure evidence survives in full');
  assert.ok(rendered.length < JSON.stringify(artifact).length * 0.45, `expected a major cut, got ${rendered.length} vs ${JSON.stringify(artifact).length}`);
  // the canonical artifact object is not mutated
  assert.equal(artifact.developer.interfaceRealizations[0].anchors[0].resolved.fileHash.length, 64);
});

test('small artifacts pass through untouched', () => {
  const small = { schema: 'ariad-task-context-v1', task: { id: 'T2' }, developer: { interfaceRealizations: [fatBinding('f', 'i', 'a.gd')] } };
  assert.equal(slimTaskArtifactForPrompt(small), small);
});

test('the standalone role prompt renders the slimmed artifact and explains the index', () => {
  const prompt = buildStandaloneRolePrompt({
    taskArtifact: fatArtifact(),
    taskArtifactPath: '/ws/.ariad/artifacts/task-context/T1.json',
    roleProtocol: 'PROTOCOL',
    role: 'reviewer',
  });
  assert.equal(prompt.includes('fileHash'), false);
  assert.match(prompt, /indexed for prompt size/);
  assert.match(prompt, /TASK ARTIFACT PATH/);
});
