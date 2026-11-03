import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { persistPlanningState } from '../src/v2/planning-persistence.js';
import { promoteVersionedDraft } from '../src/v2/versioned-promotion.js';

function makeStore(workspace) {
  mkdirSync(join(workspace, '.ariad'), { recursive: true });
  const vs = new VersionedStore(join(workspace, '.ariad', 'state.db'));
  vs.initProject('P');
  vs.createDraft({ createdBy: 'tech_lead' });
  vs.applyTreeOps([
    { op: 'upsertContract', contract: { id: 'feature.ab', nodeType: 'feature', exportedInterfaces: [], behavior: ['AB behaves.'] } },
    { op: 'upsertTask', task: { id: 'a.b', taskKind: 'FEATURE_TASK', featureId: 'feature.ab', title: 'Leaf' } },
  ]);
  return vs;
}

test('persistPlanningState writes a valid snapshot and a prod spec export', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ariad-persist-'));
  const vs = makeStore(workspace);
  vs.promoteDraft({ approvedBy: 'pm' });
  const res = persistPlanningState({ workspace, db: vs.db, versionedStore: vs, node: 'promotion', now: new Date('2026-11-03T12:00:00.000Z') });
  assert.deepEqual(res.errors, []);
  assert.ok(res.snapshot.endsWith('.db'));
  const snapshotPath = join(workspace, res.snapshot);
  assert.ok(existsSync(snapshotPath));
  const check = new DatabaseSync(snapshotPath, { readOnly: true });
  assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  check.close();
  const exported = JSON.parse(readFileSync(join(workspace, '.ariad', 'spec-export', 'prod.json'), 'utf8'));
  assert.equal(exported.prodVersion, 1);
  assert.equal(exported.tasks.length, 1);
  assert.equal(exported.tasks[0].id, 'a.b');
  assert.equal(exported.contracts.length, 1);
  assert.equal(res.git.repo, false);
  vs.close();
});

test('promotion persists snapshot + export into the workspace', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ariad-persist-promote-'));
  const vs = makeStore(workspace);
  const res = promoteVersionedDraft({ versionedStore: vs, approvedBy: 'pm', workspace });
  assert.equal(res.version, 1);
  assert.ok(res.persistence?.snapshot);
  assert.ok(existsSync(join(workspace, res.persistence.snapshot)));
  assert.ok(existsSync(join(workspace, '.ariad', 'spec-export', 'prod.json')));
  vs.close();
});

test('in a git repo the persistence commit lands (push failure is non-blocking)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ariad-persist-git-'));
  const git = (args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(workspace, '.ariad', 'docs'), { recursive: true });
  writeFileSync(join(workspace, '.ariad', 'docs', 'REQUIREMENTS.md'), '# Requirements\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  const vs = makeStore(workspace);
  vs.promoteDraft({ approvedBy: 'pm' });
  const res = persistPlanningState({ workspace, db: vs.db, versionedStore: vs, node: 'promotion' });
  assert.equal(res.git.repo, true);
  assert.equal(res.git.committed, true);
  assert.equal(res.git.pushed, false); // no remote configured
  assert.match(res.git.note, /push failed/);
  const tracked = git(['ls-files']).toString();
  assert.match(tracked, /\.ariad\/snapshots\/state-promotion-.*\.db/);
  assert.match(tracked, /\.ariad\/spec-export\/prod\.json/);
  vs.close();
});
