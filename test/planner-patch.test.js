import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyPlannerPatch, normalizePlannerPatchFile } from '../src/v2/planner-patch.js';
import { registerAriadProjectTools } from '../src/runtime/pi-project-tools.js';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function milestoneDoc(tasks) {
  return {
    id: 'M1', title: 'Slice', goal: 'Deliver the slice.', parentId: null,
    dependsOn: [], logicalRefs: ['game'],
    acceptanceCriteria: ['Slice works.'], testStrategy: 'E2E.', tasks,
  };
}

function task(id, extra = {}) {
  return {
    id, title: `Task ${id}`, intent: `Do ${id}.`, dependsOn: [], logicalRefs: ['game'],
    acceptanceCriteria: [`${id} done.`], testStrategy: 'Tests.', ...extra,
  };
}

function stubRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-planner-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts');
  writeJson(path.join(artifactRoot, 'planner', 'milestones', 'M1.json'), milestoneDoc([task('T1')]));
  return artifactRoot;
}

const NO_VALIDATE = () => {};

test('planner patch applies add/update/remove ops and rewrites the file as valid JSON', (t) => {
  const artifactRoot = stubRoot(t);
  const file = path.join(artifactRoot, 'planner', 'milestones', 'M1.json');
  const result = applyPlannerPatch({
    artifactRoot, file: 'planner/milestones/M1.json', validate: NO_VALIDATE,
    ops: [
      { op: 'addItem', array: 'tasks', item: task('T2') },
      { op: 'updateItem', array: 'tasks', match: { id: 'T1' }, addToList: { dependsOn: ['T2'] }, set: { title: 'First task' } },
      { op: 'updateItem', array: 'tasks', match: { id: 'T1' }, addToList: { dependsOn: ['T2'] } },
    ],
  });
  assert.equal(result.created, false);
  assert.equal(result.applied.length, 3);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc.tasks.map(item => item.id), ['T1', 'T2']);
  assert.equal(doc.tasks[0].title, 'First task');
  assert.deepEqual(doc.tasks[0].dependsOn, ['T2'], 'addToList dedupes');

  applyPlannerPatch({
    artifactRoot, file: 'planner/milestones/M1.json', validate: NO_VALIDATE,
    ops: [
      { op: 'removeItem', array: 'tasks', match: { id: 'T2' } },
      { op: 'updateItem', array: 'tasks', match: { id: 'T1' }, removeFromList: { dependsOn: ['T2'] } },
      { op: 'setTop', addToList: { dependsOn: ['M0'] } },
    ],
  });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.tasks.map(item => item.id), ['T1']);
  assert.deepEqual(after.tasks[0].dependsOn, []);
  assert.deepEqual(after.dependsOn, ['M0']);
});

test('planner patch rejects duplicates, ambiguous matches, and bad targets without touching the file', (t) => {
  const artifactRoot = stubRoot(t);
  const file = path.join(artifactRoot, 'planner', 'milestones', 'M1.json');
  const before = fs.readFileSync(file, 'utf8');
  const attempt = ops => () => applyPlannerPatch({ artifactRoot, file: 'planner/milestones/M1.json', ops, validate: NO_VALIDATE });
  assert.throws(attempt([{ op: 'addItem', array: 'tasks', item: task('T1') }]), /PLANNER_PATCH_ITEM_EXISTS/);
  assert.throws(attempt([{ op: 'updateItem', array: 'tasks', match: { id: 'NOPE' }, set: { title: 'x' } }]), /PLANNER_PATCH_MATCH_COUNT/);
  assert.throws(attempt([{ op: 'updateItem', array: 'tasks', match: {}, set: { title: 'x' } }]), /PLANNER_PATCH_OP_INVALID/);
  assert.throws(attempt([{ op: 'explode', array: 'tasks' }]), /PLANNER_PATCH_OP_INVALID/);
  assert.throws(attempt([{ op: 'createDocument', document: {} }]), /PLANNER_PATCH_CREATE_MISPLACED/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  assert.throws(() => applyPlannerPatch({ artifactRoot, file: 'planner/feature-tree-diff.json', ops: [{ op: 'setTop', set: {} }], validate: NO_VALIDATE }), /PLANNER_PATCH_FILE_NOT_ALLOWED/);
  assert.throws(() => applyPlannerPatch({ artifactRoot, file: 'planner/milestones/sub/M1.json', ops: [{ op: 'setTop', set: {} }], validate: NO_VALIDATE }), /PLANNER_PATCH_FILE_NOT_ALLOWED/);
  assert.throws(() => applyPlannerPatch({ artifactRoot, file: '../escape.json', ops: [{ op: 'setTop', set: {} }], validate: NO_VALIDATE }), /PLANNER_PATCH_FILE_NOT_ALLOWED/);
  assert.equal(normalizePlannerPatchFile('.ariad/artifacts/planner/logical/game.json'), 'planner/logical/game.json');

  fs.writeFileSync(file, '{not json');
  assert.throws(attempt([{ op: 'setTop', set: { title: 'x' } }]), /PLANNER_PATCH_TARGET_UNPARSEABLE/);
});

test('planner patch validates on a staged copy and leaves the live file byte-identical on failure', (t) => {
  const artifactRoot = stubRoot(t);
  const file = path.join(artifactRoot, 'planner', 'milestones', 'M1.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => applyPlannerPatch({
    artifactRoot, file: 'planner/milestones/M1.json',
    ops: [{ op: 'addItem', array: 'tasks', item: task('T2') }],
    validate: () => { throw new Error('contract broken'); },
  }), /PLANNER_PATCH_VALIDATION_FAILED: contract broken/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('planner patch createDocument authors a new artifact then patches it', (t) => {
  const artifactRoot = stubRoot(t);
  const created = applyPlannerPatch({
    artifactRoot, file: 'planner/interfaces/milestones/M2.json', validate: NO_VALIDATE,
    ops: [
      { op: 'createDocument', document: { version: 1, nodeId: 'M2', nodeType: 'milestone', integrationTasks: [] } },
      { op: 'addItem', array: 'integrationTasks', item: { id: 'm2-e2e', title: 'E2E' } },
    ],
  });
  assert.equal(created.created, true);
  const doc = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'planner', 'interfaces', 'milestones', 'M2.json'), 'utf8'));
  assert.deepEqual(doc.integrationTasks.map(item => item.id), ['m2-e2e']);
});

function baseContract(nodeId, nodeType, extra = {}) {
  return {
    version: 1, nodeId, nodeType,
    decomposition: { kind: 'leaf', reason: 'bounded scope' },
    interfaces: [], imports: [], featureUses: [], integrationScenarios: [],
    bindings: [], featureTasks: [], taskLinks: [], integrationTasks: [],
    ...extra,
  };
}

test('planner patch passes the real strict validators on a minimal plan and refuses an id rewrite', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-planner-patch-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts');
  writeJson(path.join(artifactRoot, 'planner', 'logical', 'game.json'), { id: 'game', title: 'Game', summary: 'Complete game', parentId: null });
  writeJson(path.join(artifactRoot, 'planner', 'milestones', 'M1.json'), milestoneDoc([task('T1')]));
  writeJson(path.join(artifactRoot, 'planner', 'interfaces', 'features', 'game.json'), baseContract('game', 'feature'));
  writeJson(path.join(artifactRoot, 'planner', 'interfaces', 'milestones', 'M1.json'), baseContract('M1', 'milestone'));

  const ok = applyPlannerPatch({
    artifactRoot, file: 'planner/milestones/M1.json',
    ops: [
      { op: 'addItem', array: 'tasks', item: task('T2') },
      { op: 'updateItem', array: 'tasks', match: { id: 'T1' }, addToList: { dependsOn: ['T2'] } },
    ],
  });
  assert.equal(ok.applied.length, 2);

  const file = path.join(artifactRoot, 'planner', 'milestones', 'M1.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => applyPlannerPatch({
    artifactRoot, file: 'planner/milestones/M1.json',
    ops: [{ op: 'setTop', set: { id: 'WRONG' } }],
  }), /PLANNER_PATCH_VALIDATION_FAILED/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('ariad_planner_patch tool is tech-lead only and patches through the registered tool surface', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-planner-patch-tool-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const artifactRoot = path.join(workspace, '.ariad', 'artifacts');
  writeJson(path.join(artifactRoot, 'planner', 'logical', 'game.json'), { id: 'game', title: 'Game', summary: 'Complete game', parentId: null });
  writeJson(path.join(artifactRoot, 'planner', 'milestones', 'M1.json'), milestoneDoc([task('T1')]));
  writeJson(path.join(artifactRoot, 'planner', 'interfaces', 'features', 'game.json'), baseContract('game', 'feature'));
  writeJson(path.join(artifactRoot, 'planner', 'interfaces', 'milestones', 'M1.json'), baseContract('M1', 'milestone'));

  const capture = (role) => {
    const tools = new Map();
    registerAriadProjectTools({ registerTool: tool => tools.set(tool.name, tool) }, { workspace, taskContext: { taskId: 'planner:test', role } });
    return tools.get('ariad_planner_patch');
  };
  await assert.rejects(
    () => capture('developer').execute('call-1', { file: 'planner/milestones/M1.json', ops: [{ op: 'setTop', set: {} }] }),
    /PLANNER_PATCH_REQUIRES_TECH_LEAD/,
  );
  const result = await capture('tech_lead').execute('call-2', {
    file: 'planner/milestones/M1.json',
    ops: [{ op: 'addItem', array: 'tasks', item: task('T2') }],
  });
  assert.equal(result.details.file, 'planner/milestones/M1.json');
  const doc = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'planner', 'milestones', 'M1.json'), 'utf8'));
  assert.deepEqual(doc.tasks.map(item => item.id), ['T1', 'T2']);
});

test('planner patch batch fixes interdependent files that single-file patches cannot', (t) => {
  const artifactRoot = stubRoot(t);
  const aFile = path.join(artifactRoot, 'planner', 'interfaces', 'features', 'A.json');
  const bFile = path.join(artifactRoot, 'planner', 'interfaces', 'features', 'B.json');
  writeJson(aFile, { id: 'A', imports: ['sibling:B'] });
  writeJson(bFile, { id: 'B', imports: ['sibling:A'] });
  // Whole-tree style validation: the tree is valid only once BOTH files
  // dropped their sibling imports (mirrors the boundary-contract gate).
  const validateNoSiblingImports = (root) => {
    for (const name of ['A', 'B']) {
      const doc = JSON.parse(fs.readFileSync(path.join(root, 'planner', 'interfaces', 'features', `${name}.json`), 'utf8'));
      if ((doc.imports ?? []).some(entry => String(entry).startsWith('sibling:'))) {
        throw new Error(`${name} still imports a sibling`);
      }
    }
  };
  const fix = [{ op: 'setTop', set: { imports: [] } }];
  // A single-file patch can never pass: the other file is still invalid.
  assert.throws(() => applyPlannerPatch({
    artifactRoot, file: 'planner/interfaces/features/A.json', ops: fix, validate: validateNoSiblingImports,
  }), /PLANNER_PATCH_VALIDATION_FAILED/);
  assert.deepEqual(JSON.parse(fs.readFileSync(aFile, 'utf8')).imports, ['sibling:B']);
  // The batch repairs both atomically.
  const result = applyPlannerPatch({
    artifactRoot, validate: validateNoSiblingImports,
    patches: [
      { file: 'planner/interfaces/features/A.json', ops: fix },
      { file: 'planner/interfaces/features/B.json', ops: fix },
    ],
  });
  assert.equal(result.files.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(aFile, 'utf8')).imports, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(bFile, 'utf8')).imports, []);
});

test('planner patch batch rejects duplicates and stays atomic when a later group fails', (t) => {
  const artifactRoot = stubRoot(t);
  const file = path.join(artifactRoot, 'planner', 'milestones', 'M1.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => applyPlannerPatch({
    artifactRoot, validate: NO_VALIDATE,
    patches: [
      { file: 'planner/milestones/M1.json', ops: [{ op: 'addItem', array: 'tasks', item: task('T2') }] },
      { file: 'planner/milestones/M1.json', ops: [{ op: 'setTop', set: {} }] },
    ],
  }), /PLANNER_PATCH_DUPLICATE_FILE/);
  assert.throws(() => applyPlannerPatch({
    artifactRoot, validate: NO_VALIDATE,
    patches: [
      { file: 'planner/milestones/M1.json', ops: [{ op: 'addItem', array: 'tasks', item: task('T2') }] },
      { file: 'planner/logical/L1.json', ops: [{ op: 'updateItem', array: 'nodes', match: { id: 'nope' }, set: {} }] },
    ],
  }), /PLANNER_PATCH_FILE_MISSING/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
