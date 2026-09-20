import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSourceControlFinalizer } from '../src/git-source-control-finalizer.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-git-finalizer-'));
  git(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@localhost', 'commit', '-m', 'seed']);
  return dir;
}

test('git finalizer commits workspace changes without pushing when disabled', async () => {
  const dir = initRepo();
  try {
    const before = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'feature.txt'), 'implemented\n');
    const finalizer = new GitSourceControlFinalizer({ workspace: dir, push: false });
    const result = await finalizer.finalize({ taskId: 'T1', strategyEpoch: 1, devCycle: 2 });

    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.notEqual(result.commit, before);
    assert.equal(git(dir, ['status', '--porcelain']), '');
    assert.match(git(dir, ['log', '-1', '--pretty=%s']), /^Ariad: T1 \(strategy 1, cycle 2\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state checkpoint commits only .ariad and leaves unfinished product changes uncommitted', async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, '.gitignore'), '.ariad/\n');
    git(dir, ['add', '.gitignore']);
    git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@localhost', 'commit', '-m', 'ignore runtime state']);
    mkdirSync(join(dir, '.ariad', 'artifacts'), { recursive: true });
    writeFileSync(join(dir, '.ariad', 'project.json'), '{"id":"P1"}\n');
    writeFileSync(join(dir, '.ariad', 'state.db'), 'db-state');
    writeFileSync(join(dir, '.ariad', 'artifacts', 'shot.png'), 'png-bytes');
    writeFileSync(join(dir, 'feature.txt'), 'unfinished product work\n');

    const finalizer = new GitSourceControlFinalizer({ workspace: dir, push: false });
    const result = await finalizer.checkpointState({ label: 'P1 running' });

    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.match(git(dir, ['log', '-1', '--pretty=%s']), /^Ariad state: P1 running$/);
    const committed = git(dir, ['show', '--pretty=', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort();
    assert.deepEqual(committed, [
      '.ariad/artifacts/shot.png',
      '.ariad/project.json',
      '.ariad/state.db',
    ]);
    assert.match(git(dir, ['status', '--porcelain']), /\?\? feature\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state checkpoint never tracks SQLite WAL or SHM sidecars', async () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, '.ariad'), { recursive: true });
    writeFileSync(join(dir, '.ariad', 'project.json'), '{"id":"P1"}\n');
    writeFileSync(join(dir, '.ariad', 'state.db'), 'db-state');
    writeFileSync(join(dir, '.ariad', 'state.db-wal'), 'wal');
    writeFileSync(join(dir, '.ariad', 'state.db-shm'), 'shm');

    const finalizer = new GitSourceControlFinalizer({ workspace: dir, push: false });
    const result = await finalizer.checkpointState({ label: 'checkpoint' });

    assert.equal(result.ok, true);
    assert.equal(git(dir, ['ls-files', '.ariad/state.db-wal']), '');
    assert.equal(git(dir, ['ls-files', '.ariad/state.db-shm']), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full finalize commits product changes and an open SQLite state snapshot after state checkpoints', async () => {
  const dir = initRepo();
  const ariad = join(dir, '.ariad');
  mkdirSync(ariad, { recursive: true });
  writeFileSync(join(ariad, '.gitignore'), 'state.db-wal\nstate.db-shm\nstate.db-journal\n');
  writeFileSync(join(ariad, 'project.json'), '{"id":"P1"}\n');
  const store = new SQLiteV2Store(join(ariad, 'state.db'));
  try {
    store.createProject({ id: 'P1' });
    store.createTask({
      id: 'T1',
      projectId: 'P1',
      stage: 'reviewer',
      state: 'WORKING',
      history: [{ type: 'ROLE_RESULT', role: 'tester', outcome: 'PASS' }],
    });
    store.checkpoint();

    const finalizer = new GitSourceControlFinalizer({ workspace: dir, push: false });
    const stateResult = await finalizer.checkpointState({ label: 'P1 running' });
    assert.equal(stateResult.ok, true);

    writeFileSync(join(dir, 'feature.txt'), 'accepted product work\n');
    let task = store.getTask('T1');
    task = store.updateTask('T1', task.version, { state: 'DONE', execution: null });
    store.checkpoint();

    const result = await finalizer.finalize({ taskId: 'T1', strategyEpoch: 1, devCycle: 1 });
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.committed, true);
    assert.equal(git(dir, ['show', '--pretty=', '--name-only', 'HEAD']).includes('feature.txt'), true);
    assert.equal(git(dir, ['show', '--pretty=', '--name-only', 'HEAD']).includes('.ariad/state.db'), true);
    assert.equal(git(dir, ['status', '--porcelain']), '');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git finalizer reports push failure as a system failure', async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'feature.txt'), 'implemented\n');
    const finalizer = new GitSourceControlFinalizer({ workspace: dir, push: true });
    const result = await finalizer.finalize({ taskId: 'T1', strategyEpoch: 1, devCycle: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.failure, /origin|remote|repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
