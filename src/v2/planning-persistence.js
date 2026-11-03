import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Planning persistence (owner ruling 2026-11-03): important documents
// and the planning state must live in the project's git repository.
// The live store file itself stays git-ignored (it is rewritten
// constantly and carries WAL sidecars), so at every planning milestone
// - draft promotion, planning/replan batch acceptance (which promotes),
// and begin-iteration - the system persists:
//   1. a consistent snapshot of the live store (VACUUM INTO) under
//      .ariad/snapshots/state-<node>-<timestamp>.db (git-tracked), and
//   2. a readable export of the prod spec tree (versions / tasks /
//      contracts) at .ariad/spec-export/prod.json (git-tracked),
// then commits those files plus the important docs under .ariad/docs
// (REQUIREMENTS.md, FEATURES.md, features/, approvals.json) and pushes.
// Every step is best-effort: a snapshot/export/git failure is reported
// in the result and logged, never allowed to block the planning flow
// it rides on.

const DOC_PATHS = [
  '.ariad/docs/REQUIREMENTS.md',
  '.ariad/docs/FEATURES.md',
  '.ariad/docs/features',
  '.ariad/docs/approvals.json',
];

function stampOf(now) {
  return now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

function gitPersist(workspace, relPaths, node) {
  const out = { repo: false, committed: false, pushed: false, note: null };
  const git = (args, opts = {}) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe', ...opts });
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    out.repo = true;
  } catch { out.note = 'not a git repository'; return out; }
  try {
    if (relPaths.length) git(['add', '--', ...relPaths]);
    let hasStaged = false;
    try { git(['diff', '--cached', '--quiet']); } catch { hasStaged = true; }
    if (!hasStaged) { out.note = 'no changes to commit'; return out; }
    git(['commit', '-m', `Ariad planning persistence (${node}): store snapshot + spec export + docs`]);
    out.committed = true;
    try {
      git(['push'], { timeout: 60_000 });
      out.pushed = true;
    } catch (e) {
      out.note = `push failed (non-blocking): ${String(e?.message ?? e).slice(0, 200)}`;
    }
  } catch (e) {
    out.note = `git step failed (non-blocking): ${String(e?.message ?? e).slice(0, 200)}`;
  }
  return out;
}

export function persistPlanningState({ workspace, db = null, versionedStore = null, node, now = new Date() }) {
  const result = { node, snapshot: null, specExport: null, git: null, errors: [] };
  if (!workspace) { result.errors.push('no workspace'); return result; }
  const relPaths = [];

  if (db) {
    try {
      const dir = join(workspace, '.ariad', 'snapshots');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `state-${node}-${stampOf(now)}.db`);
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      result.snapshot = relative(workspace, file);
      relPaths.push(result.snapshot);
    } catch (e) {
      result.errors.push(`snapshot failed: ${e?.message ?? e}`);
    }
  }

  if (versionedStore) {
    try {
      const prod = versionedStore.getProdVersion();
      const prodVersion = typeof prod === 'number' ? prod : (prod?.version ?? null);
      const data = {
        exportedAt: now.toISOString(),
        node,
        prodVersion,
        version: prod ?? null,
        tasks: prodVersion != null ? versionedStore.listSpecTasks(prodVersion) : [],
        contracts: prodVersion != null ? versionedStore.listSpecContracts(prodVersion) : [],
      };
      const dir = join(workspace, '.ariad', 'spec-export');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'prod.json');
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      result.specExport = relative(workspace, file);
      relPaths.push(result.specExport);
    } catch (e) {
      result.errors.push(`spec export failed: ${e?.message ?? e}`);
    }
  }

  for (const docPath of DOC_PATHS) {
    if (existsSync(join(workspace, docPath))) relPaths.push(docPath);
  }

  result.git = gitPersist(workspace, relPaths, node);
  if (result.errors.length || (result.git && result.git.note)) {
    console.error(`[planning-persistence] ${node}: ${JSON.stringify({ errors: result.errors, git: result.git })}`);
  }
  return result;
}
