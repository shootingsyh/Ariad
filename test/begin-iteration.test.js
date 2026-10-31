import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { beginIteration } from '../src/v2/begin-iteration.js';

function makeAdoptedProject({ desiredState = 'STOPPED', tasks = [], issues = [], incidents = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ariad-iter-'));
  const projectsRoot = join(root, 'projects');
  const workspace = join(root, 'ws');
  mkdirSync(join(workspace, '.ariad'), { recursive: true });
  mkdirSync(join(projectsRoot, 'demo'), { recursive: true });
  writeFileSync(join(projectsRoot, 'demo', 'project-ref.json'), `${JSON.stringify({ id: 'demo', workspace }, null, 2)}\n`);
  const store = new SQLiteV2Store(join(workspace, '.ariad', 'state.db'));
  store.createProject({
    id: 'demo', workspace, desiredState, executionState: 'IDLE', activeVersion: 2, mode: 'TAKEOVER',
    unifiedTaskHistoricalExceptions: [{ id: 'ex-1' }], versionHistory: [{ version: 1, note: 'v1' }],
  });
  const insTask = store.db.prepare('INSERT INTO v2_tasks (id, project_id, data_json, version, updated_at) VALUES (?, ?, ?, 1, ?)');
  for (const task of tasks) insTask.run(task.id, 'demo', JSON.stringify(task.data), '2026-10-01T00:00:00.000Z');
  const insIssue = store.db.prepare('INSERT INTO v2_issues (id, project_id, fingerprint, state, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const issue of issues) {
    insIssue.run(issue.id, 'demo', `fp-${issue.id}`, issue.data.resolution ? 'RESOLVED' : 'OPEN',
      JSON.stringify(issue.data), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  }
  const insIncident = store.db.prepare('INSERT INTO v2_system_incidents (project_id, task_id, data_json, created_at) VALUES (?, NULL, ?, ?)');
  for (let i = 0; i < incidents; i++) insIncident.run('demo', JSON.stringify({ kind: 'probe' }), '2026-10-01T00:00:00.000Z');
  store.db.close();
  return { root, projectsRoot, workspace };
}

const baseTasks = [
  { id: 't-done', data: { taskKind: 'FEATURE_TASK', title: 'Done feature', state: 'DONE', acceptanceCriteria: ['a1'], history: [{ type: 'TASK_COMPLETED' }, { type: 'REVIEW', verdict: 'PASS' }] } },
  { id: 't-skip', data: { taskKind: 'INTEGRATION_TASK', title: 'Skipped integration', state: 'SKIPPED' } },
  { id: 't-ready', data: { taskKind: 'FEATURE_TASK', title: 'Ready feature', state: 'READY' } },
  { id: 't-proc', data: { taskKind: 'PLANNING_TASK', title: 'Planning noise', state: 'DONE' } },
];
const baseIssues = [
  { id: 'i-resolved', data: { title: 'Old bug', severity: 'high', resolution: 'fixed in v1' } },
  { id: 'i-open', data: { title: 'Open bug', severity: 'low' } },
];

test('begin-iteration archives, seeds legacy, creates versioned project record, flips pointer', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks, issues: baseIssues, incidents: 3 });
  const manager = new AriadProjectManager({ projectsRoot });
  const report = beginIteration({ manager, name: 'demo', now: new Date('2026-10-31T12:00:00.000Z') });

  assert.equal(report.newDbFile, 'state2.db');
  assert.equal(report.pointer, 'project-ref.json');
  assert.equal(report.seeded.doneCards, 1);
  assert.equal(report.seeded.skippedIdx, 1);
  assert.equal(report.seeded.resolvedIssues, 1);
  assert.equal(report.seeded.liveIssuesInserted, 1);

  const newDbPath = join(workspace, '.ariad', 'state2.db');
  assert.ok(existsSync(newDbPath));
  const ref = JSON.parse(readFileSync(join(projectsRoot, 'demo', 'project-ref.json'), 'utf8'));
  assert.equal(ref.dbFile, 'state2.db');
  assert.equal(manager.resolveProjectPaths('demo').db, newDbPath);

  const manifest = JSON.parse(readFileSync(join(report.archiveDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sha256, report.archiveSha256);
  assert.equal(manifest.deliveryTotal, 3);
  assert.deepEqual(manifest.deliveryStateCounts, { DONE: 1, SKIPPED: 1, READY: 1 });
  assert.ok(existsSync(join(report.archiveDir, 'state.db')));

  const versioned = new VersionedStore(newDbPath);
  assert.equal(versioned.projectId, 'demo');
  const kinds = versioned.listLegacy().map(e => e.kind).sort();
  assert.deepEqual(kinds, ['done_card', 'incident_digest', 'issue_resolved', 'project_facts', 'skipped_index']);
  const card = versioned.getLegacy('done_card', 't-done');
  assert.equal(card.payload.verdict, 'PASS');
  const live = versioned.listIssues();
  assert.equal(live.length, 1);
  assert.equal(live[0].title, 'Open bug');
  versioned.close();

  const runtime = new SQLiteV2Store(newDbPath);
  const project = runtime.getProject('demo');
  assert.equal(project.versionedTree, true);
  assert.equal(project.desiredState, 'STOPPED');
  runtime.db.close();

  const old = new SQLiteV2Store(join(workspace, '.ariad', 'state.db'));
  assert.equal(old.db.prepare('SELECT COUNT(*) AS n FROM v2_tasks').get().n, 4);
  old.db.close();
});

test('begin-iteration refuses a project that is not STOPPED', () => {
  const { projectsRoot } = makeAdoptedProject({ desiredState: 'RUNNING', tasks: baseTasks });
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => beginIteration({ manager, name: 'demo' }), /ITERATION_PROJECT_NOT_STOPPED/);
});

test('begin-iteration refuses while a delivery task is in flight', () => {
  const tasks = [{ id: 't-work', data: { taskKind: 'FEATURE_TASK', title: 'Working feature', state: 'WORKING' } }];
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks });
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => beginIteration({ manager, name: 'demo' }), /ITERATION_DELIVERY_IN_FLIGHT/);
  assert.ok(!existsSync(join(workspace, '.ariad', 'state2.db')));
});

test('begin-iteration refuses an existing target store', () => {
  const { projectsRoot } = makeAdoptedProject({ tasks: baseTasks });
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => beginIteration({ manager, name: 'demo', dbFile: 'state.db' }), /ITERATION_TARGET_EXISTS/);
  const ref = JSON.parse(readFileSync(join(projectsRoot, 'demo', 'project-ref.json'), 'utf8'));
  assert.equal(ref.dbFile, undefined);
});
