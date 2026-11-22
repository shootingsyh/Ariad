import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashStateDbReference, deliveryToolPolicy } from '../src/runtime/pi-agent-session-provider.js';
import { ariadStateDbRefInTask } from '../src/v2/state-db-refs.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { VersionedTaskStore } from '../src/v2/versioned-task-store.js';

const WS = '/home/test/project';
const ws = { workspace: WS };

// --- bash: state database references are detected ---

test('bash: copying the state database is detected', () => {
  assert.equal(bashStateDbReference('cp state.db state.db.bak-tc6-20261122'), 'state.db');
});

test('bash: opening the store through a spawned interpreter is detected', () => {
  assert.equal(bashStateDbReference('python3 -c "import sqlite3; sqlite3.connect(\'state.db\')"'), 'state.db');
  assert.match(bashStateDbReference('sqlite3 .ariad/state.db "select 1"'), /\.ariad\/state\.db/);
  assert.equal(bashStateDbReference('cat state.db-wal'), 'state.db-wal');
});

test('bash: ordinary project commands are not state-db references', () => {
  assert.equal(bashStateDbReference('python3 tools/run_tests.py && ls src/'), null);
  assert.equal(bashStateDbReference('grep -rn statement docs/statement.db.md'), null);
  assert.equal(bashStateDbReference('godot --export-release game.db'), null);
});

test('policy: developer bash touching the state database is blocked', () => {
  const v = deliveryToolPolicy('developer', 'bash', { ...ws, input: { command: 'cp state.db state.db.bak-x' } });
  assert.equal(v?.block, true);
  assert.match(v.reason, /PROTECTED_ARIAD_STATE/);
});

test('policy: test_engineer heredoc opening the store is blocked', () => {
  const cmd = 'python3 - <<\'EOF\'\nimport sqlite3\ncon = sqlite3.connect(\'state.db\')\nEOF';
  const v = deliveryToolPolicy('test_engineer', 'bash', { ...ws, input: { command: cmd } });
  assert.equal(v?.block, true);
  assert.match(v.reason, /PROTECTED_ARIAD_STATE/);
});

test('policy: ordinary developer bash is allowed', () => {
  assert.equal(deliveryToolPolicy('developer', 'bash', { ...ws, input: { command: 'python3 tools/run_tests.py' } }), null);
});

// --- task text: state database references ---

test('task fields: a state-db reference in any authored field is found', () => {
  assert.equal(ariadStateDbRefInTask({ title: 'Fix', intent: 'edit state.db directly' }), 'state.db');
  assert.equal(ariadStateDbRefInTask({ title: 'Fix', acceptanceCriteria: ['update .ariad/state.db rows'] }), '.ariad/state.db');
  assert.equal(ariadStateDbRefInTask({ title: 'Fix the plan', intent: 'repair the stored reference', testStrategy: 'run the leaf CI' }), null);
});

// --- planning gates ---

const CONTRACT = {
  id: 'feature.alpha', nodeType: 'feature',
  exportedInterfaces: [{ id: 'alpha_api' }],
  behavior: ['Alpha must charge before it can fire.'],
};
const M = { id: 'm-1', taskKind: 'MILESTONE_TASK', title: 'Milestone one', parentId: null, dependsOn: [], interfaceIds: [], executionMode: 'direct' };
const F = { id: 'f-1', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Feature leaf', parentId: 'm-1', dependsOn: [], interfaceIds: ['alpha_api'], executionMode: 'direct' };

function makeFacade(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-sdb-'));
  const file = join(dir, 'state.db');
  const runtime = new SQLiteV2Store(file);
  runtime.createProject({ id: 'proj', name: 'P', versionedTree: true });
  const seed = new VersionedStore(file);
  seed.initProject('proj');
  const facade = new VersionedTaskStore(runtime);
  t.after(() => { facade.close(); seed.close(); runtime.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, seed, facade };
}

test('tree patch: a task targeting the state database fails validation', (t) => {
  const { seed } = makeFacade(t);
  seed.createDraft({ createdBy: 'tl' });
  const bad = { ...F, intent: 'Repair the stored plan by editing state.db directly.' };
  assert.throws(
    () => seed.applyTreeOps([
      { op: 'upsertContract', contract: CONTRACT },
      { op: 'upsertTask', task: M },
      { op: 'upsertTask', task: bad },
    ]),
    (e) => /targets the Ariad state database/.test(e.message + JSON.stringify(e.details ?? '')),
  );
});

test('tree patch: the same task without a state-db target applies cleanly', (t) => {
  const { seed } = makeFacade(t);
  seed.createDraft({ createdBy: 'tl' });
  const ok = seed.applyTreeOps([
    { op: 'upsertContract', contract: CONTRACT },
    { op: 'upsertTask', task: M },
    { op: 'upsertTask', task: F },
  ]);
  assert.equal(ok.applied, 3);
});

test('issue queue: a triaged fix targeting the state database is refused', (t) => {
  const { runtime, seed, facade } = makeFacade(t);
  seed.createDraft({ createdBy: 'tl' });
  seed.applyTreeOps([
    { op: 'upsertContract', contract: CONTRACT },
    { op: 'upsertTask', task: M },
    { op: 'upsertTask', task: F },
  ]);
  const issue = runtime.createIssue({ projectId: 'proj', title: 'Plan entry wrong', description: 'Fix it' });
  assert.throws(
    () => facade.insertTriagedFixTask({
      projectId: 'proj', issueId: issue.id, actor: 'tech_lead',
      task: { id: 'fix-1', taskKind: 'FEATURE_TASK', title: 'Fix plan entry', intent: 'Update the rows in .ariad/state.db', acceptanceCriteria: ['entry updated'], dependsOn: [] },
      beforeTaskIds: [],
    }),
    /targets the Ariad state database/,
  );
  assert.notEqual(runtime.getIssue(issue.id).state, 'ASSIGNED');
});
