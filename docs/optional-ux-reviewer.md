# Optional UX review (staged, not activated)

This branch adds a dormant `ux_reviewer` role. Existing projects have no `uxReview.enabled` binding and therefore keep their exact Reviewer -> DONE flow. No historical tasks are migrated or replayed.

The route Reviewer -> UX Reviewer is permitted only when BOTH the project runtime was created with `project.uxReview.enabled === true` and the delivery task has `ux.required === true`. The UX Reviewer PASS completes the task; NOT_PASS routes to Developer (or Debugger after repeated failures). UX evidence must include real rendered UI captures, not code-only assertions.

Activation is deferred to a later PM-approved UX iteration: define and validate the project-level UX binding, versioned Media/UX brief, task-level UX requirement schema and plan compilation, UX model selection, and evidence contracts before setting any project flag. Do not enable UX review on the current SRPG plan or modify in-flight tasks.

The existing Reviewer source-control finalization is intentionally deferred while a task proceeds to UX Reviewer; finalization is handled by the UX Reviewer on PASS. Verify full Pi-session E2E and source-control failure recovery before activation.
