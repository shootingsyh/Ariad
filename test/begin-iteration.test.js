import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { beginIteration } from '../src/v2/begin-iteration.js';
import { ensureAriadGitignore, ensureWorkspaceGitignore } from '../src/runtime/workspace-ignore.js';

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

// Regression (2026-10-31, found live on iterprobe): production project
// rows do not carry desiredState - it lives in the manager manifest.
// The original guard read the row and refused every real project.
test('begin-iteration reads desiredState from the manager manifest, not the store row', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks, issues: baseIssues });
  // Strip desiredState from the store row to match the production shape.
  const store = new SQLiteV2Store(join(workspace, '.ariad', 'state.db'));
  const row = store.db.prepare('SELECT data_json FROM v2_projects WHERE id = ?').get('demo');
  const data = JSON.parse(row.data_json);
  delete data.desiredState;
  store.db.prepare('UPDATE v2_projects SET data_json = ? WHERE id = ?').run(JSON.stringify(data), 'demo');
  store.db.close();
  // The manager manifest is where setDesiredState records STOPPED.
  writeFileSync(join(workspace, '.ariad', 'project.json'),
    `${JSON.stringify({ id: 'demo', workspace, desiredState: 'STOPPED', executionState: 'SUCCEEDED' }, null, 2)}\n`);
  const manager = new AriadProjectManager({ projectsRoot });
  const report = beginIteration({ manager, name: 'demo', now: new Date('2026-10-31T12:30:00.000Z') });
  assert.equal(report.project, 'demo');
});

test('begin-iteration refuses when the manager manifest says RUNNING even if the row is silent', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks });
  const store = new SQLiteV2Store(join(workspace, '.ariad', 'state.db'));
  const row = store.db.prepare('SELECT data_json FROM v2_projects WHERE id = ?').get('demo');
  const data = JSON.parse(row.data_json);
  delete data.desiredState;
  store.db.prepare('UPDATE v2_projects SET data_json = ? WHERE id = ?').run(JSON.stringify(data), 'demo');
  store.db.close();
  writeFileSync(join(workspace, '.ariad', 'project.json'),
    `${JSON.stringify({ id: 'demo', workspace, desiredState: 'RUNNING', executionState: 'RUNNING' }, null, 2)}\n`);
  const manager = new AriadProjectManager({ projectsRoot });
  assert.throws(() => beginIteration({ manager, name: 'demo' }), /ITERATION_PROJECT_NOT_STOPPED/);
});

// Regression (2026-10-31, found live on iterprobe): the workspace
// manifest's stored stateDb is baked at creation; after begin-iteration
// flips dbFile, status() must report the NEW store path, or the daemon
// keeps opening the old store and the iteration never starts.
test('status reports the store resolved from the dbFile pointer, not the stale manifest stateDb', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks });
  writeFileSync(join(workspace, '.ariad', 'project.json'),
    `${JSON.stringify({ id: 'demo', workspace, desiredState: 'STOPPED', executionState: 'SUCCEEDED', stateDb: join(workspace, '.ariad', 'state.db') }, null, 2)}\n`);
  const manager = new AriadProjectManager({ projectsRoot });
  assert.equal(manager.status('demo').stateDb, join(workspace, '.ariad', 'state.db'));
  beginIteration({ manager, name: 'demo', now: new Date('2026-10-31T12:45:00.000Z') });
  assert.equal(manager.status('demo').stateDb, join(workspace, '.ariad', 'state2.db'));
});

test('begin-iteration resets the manifest executionState so the new version is not born SUCCEEDED', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks });
  writeFileSync(join(workspace, '.ariad', 'project.json'),
    `${JSON.stringify({ id: 'demo', workspace, desiredState: 'STOPPED', executionState: 'SUCCEEDED' }, null, 2)}\n`);
  const manager = new AriadProjectManager({ projectsRoot });
  beginIteration({ manager, name: 'demo', now: new Date('2026-10-31T12:50:00.000Z') });
  assert.equal(manager.status('demo').executionState, 'IDLE');
});

// Regressions (2026-10-31, iterprobe live findings): the new version
// must start with its delivery gate closed, and the previous store's
// legacy zone must carry forward into the next iteration.
test('begin-iteration starts the new version with the delivery gate closed', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks });
  const store = new SQLiteV2Store(join(workspace, '.ariad', 'state.db'));
  const row = store.getProject('demo');
  store.updateProject('demo', row.version, { deliveryEnabled: true });
  store.db.close();
  const manager = new AriadProjectManager({ projectsRoot });
  beginIteration({ manager, name: 'demo', now: new Date('2026-10-31T13:00:00.000Z') });
  const next = new SQLiteV2Store(join(workspace, '.ariad', 'state2.db'));
  try {
    assert.equal(next.getProject('demo').deliveryEnabled, false);
    assert.ok(next.filePath.endsWith('state2.db'));
  } finally { next.db.close(); }
});

test('begin-iteration carries the previous store legacy zone forward', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks });
  const vs = new VersionedStore(join(workspace, '.ariad', 'state.db'));
  vs.initProject('demo');
  vs.putLegacyEntries([{ kind: 'done_card', oldId: 'ancient-task', summary: 'Ancient done', payload: { title: 'Ancient done' } }]);
  vs.close();
  const manager = new AriadProjectManager({ projectsRoot });
  const report = beginIteration({ manager, name: 'demo', now: new Date('2026-10-31T13:05:00.000Z') });
  assert.equal(report.seeded.carriedLegacy, 1);
  const nextVs = new VersionedStore(join(workspace, '.ariad', 'state2.db'));
  try {
    const kinds = nextVs.listLegacy().map(e => `${e.kind}:${e.oldId}`);
    assert.ok(kinds.includes('done_card:ancient-task'), `carried entry missing, got ${kinds.join(', ')}`);
    assert.ok(kinds.includes('done_card:t-done'), 'freshly distilled cards still seeded');
  } finally { nextVs.close(); }
});

test('begin-iteration archives persistent role sessions for a fresh planning start', () => {
  const { projectsRoot, workspace } = makeAdoptedProject({ tasks: baseTasks, issues: baseIssues });
  const persistentDir = join(workspace, '.ariad', 'pi', 'sessions', 'persistent');
  mkdirSync(join(persistentDir, 'sess-tl'), { recursive: true });
  mkdirSync(join(persistentDir, 'sess-pm'), { recursive: true });
  writeFileSync(join(persistentDir, 'sess-tl', 'ariad-session.json'), '{"role":"tech_lead"}\n');
  const manager = new AriadProjectManager({ projectsRoot });
  const report = beginIteration({ manager, name: 'demo', now: new Date('2026-10-31T12:00:00.000Z') });
  assert.equal(report.sessionsArchived, 2);
  assert.equal(existsSync(persistentDir), false);
  const archived = join(workspace, '.ariad', 'pi', 'session-archive', '2026-10-31T12-00-00-000Z', 'persistent', 'sess-tl', 'ariad-session.json');
  assert.ok(existsSync(archived));
});

test('workspace ignore coverage merges canonical lines without clobbering or duplicating', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-ignore-'));
  const ws = join(dir, 'ws');
  const ariad = join(ws, '.ariad');
  mkdirSync(ariad, { recursive: true });
  writeFileSync(join(ws, '.gitignore'), 'build/\n');
  writeFileSync(join(ariad, '.gitignore'), 'state.db-wal\n');
  ensureWorkspaceGitignore(ws);
  ensureAriadGitignore(ariad);
  ensureWorkspaceGitignore(ws);
  ensureAriadGitignore(ariad);
  const root = readFileSync(join(ws, '.gitignore'), 'utf8');
  assert.ok(root.startsWith('build/\n'));
  assert.equal(root.split('\n').filter(l => l === '/ignore/').length, 1);
  assert.equal(root.split('\n').filter(l => l === '/backups/').length, 1);
  const inner = readFileSync(join(ariad, '.gitignore'), 'utf8');
  assert.ok(inner.includes('state.db-wal'));
  for (const line of ['/state*.db*', '/memory.db*', '/pi/', '/run_logs/']) {
    assert.equal(inner.split('\n').filter(l => l === line).length, 1, line);
  }
});

test('manager.create gives a new project an ignore folder and default gitignore coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-create-'));
  const manager = new AriadProjectManager({ projectsRoot: join(root, 'projects') });
  const roleModels = Object.fromEntries(['pm', 'tech_lead', 'tech_lead_critic', 'developer', 'tester', 'reviewer', 'project_debugger', 'artist'].map(r => [r, 'x/y']));
  const created = manager.create('demo-new', { goal: 'g', roleModels });
  assert.ok(existsSync(join(created.workspace, 'ignore')));
  const rootIgnore = readFileSync(join(created.workspace, '.gitignore'), 'utf8');
  assert.ok(rootIgnore.includes('/ignore/'));
  assert.ok(rootIgnore.includes('/backups/'));
  const innerIgnore = readFileSync(join(created.workspace, '.ariad', '.gitignore'), 'utf8');
  assert.ok(innerIgnore.includes('/pi/'));
  assert.ok(innerIgnore.includes('/state*.db*'));
});
