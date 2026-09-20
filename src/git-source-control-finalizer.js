import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

function ariadPaths(workspace) {
  return [
    '.ariad/project.json',
    '.ariad/state.db',
    '.ariad/artifacts',
  ].filter(path => existsSync(join(workspace, path)));
}

function stageAriadState(workspace) {
  const paths = ariadPaths(workspace);
  if (paths.length === 0) return [];
  runGit(workspace, ['add', '-f', '--', ...paths]);
  return paths;
}


export class GitSourceControlFinalizer {
  constructor({ workspace, push = true, remote = 'origin' }) {
    if (!workspace) throw new Error('workspace is required');
    this.workspace = workspace;
    this.push = Boolean(push);
    this.remote = remote;
  }

  async checkpointState({ label = 'runtime' } = {}) {
    try {
      runGit(this.workspace, ['rev-parse', '--is-inside-work-tree']);
      const paths = stageAriadState(this.workspace);
      if (paths.length === 0) return { ok: true, committed: false, pushed: false, commit: null };

      const staged = runGit(this.workspace, ['diff', '--cached', '--name-only', '--', ...paths]);
      let committed = false;
      if (staged) {
        runGit(this.workspace, [
          '-c', 'user.name=Ariad',
          '-c', 'user.email=ariad@localhost',
          'commit', '--only', '-m', `Ariad state: ${label}`, '--', ...paths,
        ]);
        committed = true;
      }

      const commit = runGit(this.workspace, ['rev-parse', 'HEAD']);
      if (this.push && committed) runGit(this.workspace, ['push', this.remote, 'HEAD']);
      return { ok: true, commit, committed, pushed: this.push && committed };
    } catch (error) {
      return { ok: false, failure: failureMessage(error), pushed: false };
    }
  }

  async finalize({ taskId, strategyEpoch, devCycle }) {
    try {
      runGit(this.workspace, ['rev-parse', '--is-inside-work-tree']);
      runGit(this.workspace, ['add', '-A']);
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
