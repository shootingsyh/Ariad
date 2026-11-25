import { docsRegimeAdopted, requirementsStatus } from './project-docs.js';
import { persistPlanningState } from './planning-persistence.js';

// PM promotion for DB-first projects, de-materialized (2026-10-31):
// promotion is a pointer flip, not a copy. The draft version becomes
// prod in the versioned store; the scheduler reads the prod task tree
// directly through VersionedTaskStore (prod specs joined with exec
// records), so nothing is materialized into the runtime task table.
// Executed-work protection (DONE gate signatures frozen, in-flight
// defers, blocked tasks never revised) is enforced by
// VersionedStore.promoteDraft against the exec records. The returned
// created/updated/obsoleted lists come from the pre-promotion draft
// diff and describe the spec delta for the PM's summary only.
export function promoteVersionedDraft({ versionedStore, workspace = null, approvedBy = null, expectedDiffHash = null, uxReviewEnabled = false }) {
  // Root-document gate (same semantics as the file-based flow): when the
  // project has adopted the docs regime (.ariad/docs exists), a version
  // may only be promoted from human-finalized requirements. PM finalizes
  // REQUIREMENTS.md with the human; a human approves it (hash-pinned, so
  // editing the document after approval re-opens the gate).
  if (workspace && docsRegimeAdopted(workspace)) {
    const status = requirementsStatus(workspace);
    if (!status.exists) {
      const err = new Error('REQUIREMENTS_NOT_FINALIZED: .ariad/docs/REQUIREMENTS.md is missing - PM must finalize the version requirements document with the human before the DB draft can be promoted');
      err.code = 'REQUIREMENTS_NOT_FINALIZED';
      throw err;
    }
    if (!status.approved) {
      const err = new Error('REQUIREMENTS_NOT_APPROVED: the requirements document was edited after approval (or never approved) - a human must re-approve it (ariad project approve-requirements) before the DB draft can be promoted');
      err.code = 'REQUIREMENTS_NOT_APPROVED';
      throw err;
    }
  }
  const draft = versionedStore.getOpenDraft();
  if (!draft) {
    const err = new Error('NO_OPEN_DRAFT');
    err.code = 'NO_OPEN_DRAFT';
    throw err;
  }
  const validationErrors = versionedStore.validateVersion(draft.version, { requireUxDecision: uxReviewEnabled });
  if (validationErrors.length) {
    const err = new Error(`TREE_VALIDATION_FAILED: ${validationErrors.join('; ')}`);
    err.code = 'TREE_VALIDATION_FAILED';
    err.details = validationErrors;
    throw err;
  }
  const diff = versionedStore.diffDraft();
  // Diff-approval guards (owner design, 2026-11-22): promotion lands
  // exactly the diff the PM approved. An empty diff must never be
  // promoted (SRPG batch-234 promoted an unchanged tree as if the
  // requested change had been made); when the approval named a diff
  // hash, a draft changed since approval is refused.
  const diffEmpty = [diff.tasks.added, diff.tasks.removed, diff.tasks.changed, diff.contracts.added, diff.contracts.removed, diff.contracts.changed]
    .every(list => list.length === 0);
  if (diffEmpty && draft.base_version != null) {
    const prodRow = versionedStore.db.prepare('SELECT requirements_hash FROM spec_versions WHERE version = ?').get(versionedStore.getProdVersion());
    if ((draft.requirements_hash ?? null) === (prodRow?.requirements_hash ?? null)) {
      const err = new Error('EMPTY_DIFF: the open draft changes nothing against prod (no task or contract changes, requirements unchanged) - there is nothing to promote; if this batch was opened to change the plan, the change never landed in the draft');
      err.code = 'EMPTY_DIFF';
      throw err;
    }
  }
  if (expectedDiffHash != null && expectedDiffHash !== diff.diffHash) {
    const err = new Error(`DIFF_CHANGED_SINCE_APPROVAL: the draft diff hash is now ${diff.diffHash} but the approval named ${expectedDiffHash} - the plan changed after approval and must be reviewed again`);
    err.code = 'DIFF_CHANGED_SINCE_APPROVAL';
    throw err;
  }
  const flip = versionedStore.promoteDraft({ approvedBy });
  // Planning persistence (2026-11-03): a promotion - including the
  // promotion that accepts a planning/replan batch - persists a store
  // snapshot + prod spec export into the project repo (best-effort,
  // never blocks the promotion; see planning-persistence.js).
  const persistence = workspace
    ? persistPlanningState({ workspace, db: versionedStore.db, versionedStore, node: 'promotion' })
    : null;
  return {
    persistence,
    created: diff.tasks.added,
    updated: diff.tasks.changed,
    obsoleted: diff.tasks.removed,
    diffHash: diff.diffHash,
    total: versionedStore.listSpecTasks(flip.version).length,
    version: flip.version,
    contentHash: flip.contentHash,
  };
}
