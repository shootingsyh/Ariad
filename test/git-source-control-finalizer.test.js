import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSourceControlFinalizer } from '../src/git-source-control-finalizer.js';

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
