import { docsRegimeAdopted, requirementsStatus } from './project-docs.js';

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
export function promoteVersionedDraft({ versionedStore, workspace = null, approvedBy = null }) {
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
  const validationErrors = versionedStore.validateVersion(draft.version);
  if (validationErrors.length) {
    const err = new Error(`TREE_VALIDATION_FAILED: ${validationErrors.join('; ')}`);
    err.code = 'TREE_VALIDATION_FAILED';
    err.details = validationErrors;
    throw err;
  }
  const diff = versionedStore.diffDraft();
  const flip = versionedStore.promoteDraft({ approvedBy });
  return {
    created: diff.tasks.added,
    updated: diff.tasks.changed,
    obsoleted: diff.tasks.removed,
    total: versionedStore.listSpecTasks(flip.version).length,
    version: flip.version,
    contentHash: flip.contentHash,
  };
}
