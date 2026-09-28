import { execFileSync } from 'node:child_process';

function runGit(workspace, args) {
  return execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function failureMessage(error) {
  const stderr = error?.stderr?.toString?.().trim();
  const stdout = error?.stdout?.toString?.().trim();
  return stderr || stdout || error?.message || String(error);
}

function stageAriadState(workspace) {
  try {
    runGit(workspace, [
      'add', '-f', '-A', '--', '.ariad',
      ':(exclude).ariad/state.db-wal',
      ':(exclude).ariad/state.db-shm',
      ':(exclude).ariad/state.db-journal',
    ]);
    return ['.ariad'];
  } catch (error) {
    const message = failureMessage(error);
    if (/pathspec .*\.ariad.* did not match/i.test(message)) return [];
    throw error;
  }
}

export class GitSourceControlFinalizer {
  constructor({ workspace, push = true, remote = 'origin' }) {
    if (!workspace) throw new Error('workspace is required');
    this.workspace = workspace;
    this.push = Boolean(push);
    this.remote = remote;
  }

  // Runtime truth lives in SQLite. Reconcile cycles must never manufacture Git
  // history merely because durable scheduler/task state changed. Keep this
  // compatibility method as a no-op for older callers while feature/reviewer
  // finalization below remains the only place that creates product commits.
  async checkpointState(_options = {}) {
    return { ok: true, committed: false, pushed: false, commit: null, failure: null };
  }

  async finalize({ taskId, strategyEpoch, devCycle }) {
    try {
      runGit(this.workspace, ['rev-parse', '--is-inside-work-tree']);
      // Normal product staging respects repository ignore rules, including
      // .ariad/.gitignore for transient SQLite sidecars.
      runGit(this.workspace, ['add', '-A']);
      // Ariad durable state is first-class project data even if the product
      // repository historically ignored .ariad/.
      stageAriadState(this.workspace);

      const staged = runGit(this.workspace, ['diff', '--cached', '--name-only']);
      let committed = false;
      if (staged) {
        const message = `Ariad: ${taskId} (strategy ${strategyEpoch}, cycle ${devCycle})`;
        runGit(this.workspace, [
          '-c', 'user.name=Ariad',
          '-c', 'user.email=ariad@localhost',
          'commit', '-m', message,
        ]);
        committed = true;
      }

      const commit = runGit(this.workspace, ['rev-parse', 'HEAD']);
      const branch = runGit(this.workspace, ['branch', '--show-current']);
      if (this.push) runGit(this.workspace, ['push', this.remote, 'HEAD']);

      return {
        ok: true,
        commit,
        branch,
        committed,
        pushed: this.push,
      };
    } catch (error) {
      return {
        ok: false,
        failure: failureMessage(error),
        pushed: false,
      };
    }
  }
}
