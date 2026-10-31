import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

// Project document system (design 2026-10-30):
// - Living master documents live at the .ariad/docs root (REQUIREMENTS.md,
//   PROJECT.md, CONTINUE.md, FEATURES.md + features/<nodeId>.md).
// - Version-bound material lives under .ariad/versions/v<N>/.
// - History is carried by the project git, never by frozen copies.
// - Documents are files; the DB only ever stores references to them.
// The regime applies to a project once it keeps a docs root at all.

export function projectDocsRoot(workspace) {
  return join(workspace, '.ariad', 'docs');
}

export function projectVersionsRoot(workspace) {
  return join(workspace, '.ariad', 'versions');
}

export function docsRegimeAdopted(workspace) {
  return existsSync(projectDocsRoot(workspace));
}

function docsFail(message) {
  const error = new Error(`PROJECT_DOCS_INCOMPLETE: ${message}`);
  error.code = 'PROJECT_DOCS_INCOMPLETE';
  throw error;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Gate check for a planning batch: every feature the batch adds or updates
// must arrive with its feature document and a FEATURES.md index entry in the
// same batch; removed features must leave the index. Untouched stored
// features are not retroactively judged (they converge as batches pass by).
export function validateFeatureDocs(workspace, { changedNodeIds = [], removedNodeIds = [] } = {}) {
  const docsRoot = projectDocsRoot(workspace);
  if (!existsSync(docsRoot)) return { ok: true, adopted: false };
  const indexPath = join(docsRoot, 'FEATURES.md');
  if (!existsSync(indexPath)) {
    docsFail('FEATURES.md index missing at .ariad/docs root (feature documents and their index live at the docs root)');
  }
  const index = readFileSync(indexPath, 'utf8');
  for (const nodeId of changedNodeIds) {
    if (!existsSync(join(docsRoot, 'features', `${nodeId}.md`))) {
      docsFail(`changed feature ${nodeId} has no feature document at .ariad/docs/features/${nodeId}.md (tree and documents change in the same batch)`);
    }
    if (!index.includes(nodeId)) {
      docsFail(`FEATURES.md does not list changed feature ${nodeId}`);
    }
  }
  for (const nodeId of removedNodeIds) {
    if (index.includes(nodeId)) {
      docsFail(`FEATURES.md still lists removed feature ${nodeId}`);
    }
  }
  return { ok: true, adopted: true };
}

// Non-throwing full-tree drift report (reconcile-time accounting): which
// logical features lack a document or an index entry, and which index
// entries no longer name a living feature. Drift is reported, never
// silently repaired.
export function collectFeatureDocDrift(workspace, featureNodeIds) {
  const docsRoot = projectDocsRoot(workspace);
  if (!existsSync(docsRoot)) return { adopted: false, missingDocs: [], unlisted: [], stale: [] };
  const indexPath = join(docsRoot, 'FEATURES.md');
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  const missingDocs = [];
  const unlisted = [];
  for (const nodeId of featureNodeIds) {
    if (!existsSync(join(docsRoot, 'features', `${nodeId}.md`))) missingDocs.push(nodeId);
    if (!index.includes(nodeId)) unlisted.push(nodeId);
  }
  return { adopted: true, missingDocs, unlisted, stale: [] };
}

// Requirements approval record: the human-approved requirements document is
// the PM's yardstick. The record lives with the documents (file-first); it
// pins the exact approved bytes by hash so later edits void the approval
// until a human re-approves.
export function requirementsPath(workspace) {
  return join(projectDocsRoot(workspace), 'REQUIREMENTS.md');
}

export function approvalsPath(workspace) {
  return join(projectDocsRoot(workspace), 'approvals.json');
}

export function readApprovals(workspace) {
  const path = approvalsPath(workspace);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function requirementsStatus(workspace) {
  const path = requirementsPath(workspace);
  if (!existsSync(path)) return { exists: false, approved: false, approval: null, sha256: null };
  const sha256 = sha256File(path);
  const approval = readApprovals(workspace).requirements ?? null;
  return {
    exists: true,
    sha256,
    approved: Boolean(approval && approval.sha256 === sha256),
    approval,
  };
}

export function recordRequirementsApproval(workspace, { approvedBy, version = null } = {}) {
  const path = requirementsPath(workspace);
  if (!existsSync(path)) docsFail('REQUIREMENTS.md does not exist; nothing to approve');
  const approvals = readApprovals(workspace);
  approvals.requirements = {
    path: '.ariad/docs/REQUIREMENTS.md',
    sha256: sha256File(path),
    approvedBy: approvedBy ?? 'human',
    approvedAt: new Date().toISOString(),
    version,
  };
  const target = approvalsPath(workspace);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(approvals, null, 2) + '\n');
  return approvals.requirements;
}
