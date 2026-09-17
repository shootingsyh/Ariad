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

export class GitSourceControlFinalizer {
  constructor({ workspace, push = true, remote = 'origin' }) {
    if (!workspace) throw new Error('workspace is required');
    this.workspace = workspace;
    this.push = Boolean(push);
    this.remote = remote;
  }

  async finalize({ taskId, strategyEpoch, devCycle }) {
    try {
      runGit(this.workspace, ['rev-parse', '--is-inside-work-tree']);
      runGit(this.workspace, ['add', '-A']);

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
