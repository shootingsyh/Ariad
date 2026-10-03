import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginRevisionPass,
  compileFeatureRevisionDiff,
  finishRevisionPass,
  validateRevisionTraversalComplete,
} from '../src/v2/revision-traversal.js';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function feature(root, id, parentId) {
  writeJson(path.join(root, 'planner', 'logical', `${id}.json`), {
    id,
    title: id,
    summary: `summary ${id}`,
    parentId,
  });
}

function decision(root, nodeId, value) {
  writeJson(
    path.join(root, 'planner', 'revision', 'feature', 'decisions', `${nodeId}.json`),
    {
      version: 1,
      nodeType: 'feature',
      nodeId,
      ...value,
    },
  );
}

test('revision traversal is top-down BFS and can prune an unaffected subtree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-revision-'));
  try {
    feature(root, 'root', null);
    feature(root, 'a', 'root');
    feature(root, 'b', 'root');
    feature(root, 'a1', 'a');

    let pass = beginRevisionPass(root, 'feature');
    assert.equal(pass.node.id, 'root');
    decision(root, 'root', {
      action: 'KEEP',
      visitChildren: true,
      reason: 'Root contract remains valid, inspect children.',
    });
    pass = finishRevisionPass(root, 'feature');
    assert.equal(pass.next.node.id, 'a');

    beginRevisionPass(root, 'feature');
    decision(root, 'a', {
      action: 'KEEP',
      visitChildren: false,
      reason: 'A and its whole subtree are unaffected.',
    });
    pass = finishRevisionPass(root, 'feature');
    assert.equal(pass.next.node.id, 'b');

    beginRevisionPass(root, 'feature');
    decision(root, 'b', {
      action: 'AMEND',
      visitChildren: false,
      reason: 'B wording changes but structure stays stable.',
      patch: { summary: 'updated b summary' },
    });
    pass = finishRevisionPass(root, 'feature');
    assert.equal(pass.complete, true);

    const summary = validateRevisionTraversalComplete(root, 'feature');
    assert.equal(summary.visited, 3);

    const diff = compileFeatureRevisionDiff(root, 2);
    assert.deepEqual(diff, {
      version: 1,
      targetVersion: 2,
      operations: [{
        op: 'update',
        id: 'b',
        patch: { summary: 'updated b summary' },
        reason: 'B wording changes but structure stays stable.',
      }],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removing a node requires its parent to participate in the revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-revision-remove-'));
  try {
    feature(root, 'root', null);
    feature(root, 'child', 'root');

    beginRevisionPass(root, 'feature');
    decision(root, 'root', {
      action: 'KEEP',
      visitChildren: true,
      reason: 'Inspect child.',
    });
    finishRevisionPass(root, 'feature');

    beginRevisionPass(root, 'feature');
    decision(root, 'child', {
      action: 'REMOVE',
      visitChildren: false,
      reason: 'Child is obsolete.',
    });
    finishRevisionPass(root, 'feature');

    assert.throws(
      () => validateRevisionTraversalComplete(root, 'feature'),
      /REMOVE requires parent root to be AMEND\/REFINE\/REMOVE/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REFINE marks the existing node for later one-layer frontier expansion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-revision-refine-'));
  try {
    feature(root, 'root', null);

    beginRevisionPass(root, 'feature');
    decision(root, 'root', {
      action: 'REFINE',
      visitChildren: false,
      reason: 'Root needs a new direct-child decomposition.',
    });
    finishRevisionPass(root, 'feature');

    const result = validateRevisionTraversalComplete(root, 'feature');
    assert.deepEqual(result.refinementTargets, ['root']);
    assert.deepEqual(compileFeatureRevisionDiff(root, 3).operations, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
