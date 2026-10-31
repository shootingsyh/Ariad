import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectFeatureDocDrift,
  projectDocsRoot,
  recordRequirementsApproval,
  requirementsStatus,
  validateFeatureDocs,
} from '../src/v2/project-docs.js';

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-project-docs-'));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('projects without a docs root are outside the regime', () => {
  const ws = tempWorkspace();
  assert.deepEqual(validateFeatureDocs(ws, { changedNodeIds: ['a.b'] }), { ok: true, adopted: false });
  assert.equal(collectFeatureDocDrift(ws, ['a.b']).adopted, false);
});

test('adopted projects need the FEATURES index at the docs root', () => {
  const ws = tempWorkspace();
  write(path.join(projectDocsRoot(ws), 'PROJECT.md'), '# project\n');
  assert.throws(() => validateFeatureDocs(ws, {}), /FEATURES\.md index missing/);
});

test('changed features need a document and an index entry in the same batch', () => {
  const ws = tempWorkspace();
  const docs = projectDocsRoot(ws);
  write(path.join(docs, 'FEATURES.md'), '# Features\n\n- other.feature\n');
  assert.throws(
    () => validateFeatureDocs(ws, { changedNodeIds: ['battle.flow'] }),
    /changed feature battle\.flow has no feature document/,
  );
  write(path.join(docs, 'features', 'battle.flow.md'), '# battle.flow\n');
  assert.throws(
    () => validateFeatureDocs(ws, { changedNodeIds: ['battle.flow'] }),
    /FEATURES\.md does not list changed feature battle\.flow/,
  );
  write(path.join(docs, 'FEATURES.md'), '# Features\n\n- battle.flow\n- other.feature\n');
  assert.deepEqual(validateFeatureDocs(ws, { changedNodeIds: ['battle.flow'] }), { ok: true, adopted: true });
});

test('removed features must leave the index; untouched features are not judged', () => {
  const ws = tempWorkspace();
  const docs = projectDocsRoot(ws);
  write(path.join(docs, 'FEATURES.md'), '# Features\n\n- gone.feature\n');
  assert.throws(
    () => validateFeatureDocs(ws, { removedNodeIds: ['gone.feature'] }),
    /FEATURES\.md still lists removed feature gone\.feature/,
  );
  // An unrelated stored feature with no document does not block other work.
  assert.deepEqual(validateFeatureDocs(ws, { changedNodeIds: [] }), { ok: true, adopted: true });
});

test('drift report names missing documents and unlisted features without throwing', () => {
  const ws = tempWorkspace();
  const docs = projectDocsRoot(ws);
  write(path.join(docs, 'FEATURES.md'), '# Features\n\n- documented.feature\n');
  write(path.join(docs, 'features', 'documented.feature.md'), '# documented\n');
  const drift = collectFeatureDocDrift(ws, ['documented.feature', 'bare.feature']);
  assert.equal(drift.adopted, true);
  assert.deepEqual(drift.missingDocs, ['bare.feature']);
  assert.deepEqual(drift.unlisted, ['bare.feature']);
});

test('requirements approval pins the approved bytes by hash', () => {
  const ws = tempWorkspace();
  const docs = projectDocsRoot(ws);
  assert.throws(() => recordRequirementsApproval(ws, { approvedBy: 'human' }), /REQUIREMENTS\.md does not exist/);
  write(path.join(docs, 'REQUIREMENTS.md'), '# Requirements\n\nBuild the thing.\n');
  let status = requirementsStatus(ws);
  assert.equal(status.exists, true);
  assert.equal(status.approved, false);
  const approval = recordRequirementsApproval(ws, { approvedBy: 'human', version: 3 });
  assert.equal(approval.version, 3);
  status = requirementsStatus(ws);
  assert.equal(status.approved, true);
  assert.equal(status.approval.approvedBy, 'human');
  // Editing the requirements voids the approval until a human re-approves.
  write(path.join(docs, 'REQUIREMENTS.md'), '# Requirements\n\nBuild the other thing.\n');
  status = requirementsStatus(ws);
  assert.equal(status.exists, true);
  assert.equal(status.approved, false);
});
