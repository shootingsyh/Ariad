import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Canonical ignore coverage for Ariad's local-only runtime residue.
// The project memory store (memory.db) is tracked on purpose: it is the
// project's accumulated knowledge and should travel with the repo; only
// its live sidecar files are ignored. Session transcripts, state stores
// and logs live inside the project
// workspace (the memory curator and the runtime read them from those
// paths, so the paths stay put), but they are machine-local working
// state and must never be swept into the project's Git history by a
// blanket commit. These helpers merge the canonical lines into the
// workspace's .gitignore files, preserving whatever is already there.
export const ARIAD_DIR_GITIGNORE_LINES = [
  '# Ariad runtime state — local only, never commit',
  '/state*.db*',
  '/memory.db-wal',
  '/memory.db-shm',
  '/memory.db-journal',
  '/pi/',
  '/run_logs/',
];

export const WORKSPACE_GITIGNORE_LINES = [
  '# Ariad local-only folders — temp files and iteration archives',
  '/ignore/',
  '/backups/',
];

function ensureGitignoreLines(file, lines) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = new Set(existing.split('\n').map(line => line.trim()));
  const missing = lines.filter(line => !present.has(line.trim()));
  if (missing.length === 0) return false;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(file, existing + prefix + missing.join('\n') + '\n', 'utf8');
  return true;
}

export function ensureAriadGitignore(ariadDir) {
  return ensureGitignoreLines(join(ariadDir, '.gitignore'), ARIAD_DIR_GITIGNORE_LINES);
}

export function ensureWorkspaceGitignore(workspace) {
  return ensureGitignoreLines(join(workspace, '.gitignore'), WORKSPACE_GITIGNORE_LINES);
}

// New projects get a dedicated scratch folder for temporary files,
// covered by the workspace .gitignore block above.
export function ensureProjectIgnoreDir(workspace) {
  mkdirSync(join(workspace, 'ignore'), { recursive: true });
}
