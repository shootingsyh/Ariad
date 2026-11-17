// Issue assignment gate (owner-approved product fix, 2026-11-16).
//
// When a planning batch triages an issue (TRIAGE_AND_ASSIGN_ISSUE), the
// Tech Lead's result carries result.issueDispositions: one entry per
// issue, and for an accepted defect the entry claims the repair in
// assignedTaskIds. Nothing verified those claims: in SRPG batch-79 the
// decompose result claimed T-fix-troops-down-dimension-gate for the
// troops-down dimension-gate issue, the PM accepted the plan, and the
// task existed nowhere - not in the promoted spec, not in the issue
// queue, not among live tasks. completePlanningBatch faithfully
// recorded the issue as TRIAGED_UNASSIGNED / NO_ASSIGNEE_CREATED, but
// by then the batch was over and the defect had no owner.
//
// This module is the deterministic half of the rule, enforced by the
// plan validator (see default-roles), mirroring the sweep accounting
// gate: for every issue triaged in the batch, the batch's LAST Tech
// Lead authorship result must carry a disposition, and every task ID
// claimed in assignedTaskIds must resolve to a real task - in the
// draft (the tree route, via ariad_tree_patch) or among the project's
// live tasks (the issue-queue route, via ariad_insert_fix_task, whose
// tasks live outside the spec). A disposition without assignedTaskIds
// (rejection, duplicate, not-a-defect) needs no carrier. Whether a
// disposition is substantively right remains the PM's judgement.

export function triageIssueIds(requests) {
  const ids = [];
  for (const item of requests ?? []) {
    if (item?.request?.purpose !== 'TRIAGE_AND_ASSIGN_ISSUE') continue;
    const id = item.request.issueId ?? item.request.issue?.id ?? item.context?.issueId ?? null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Normalize result.issueDispositions into [{ issueId, disposition,
// assignedTaskIds }] - the shape Tech Lead sessions emit at the top
// level of the decompose / repair result. Returns null when the
// result carries no usable dispositions array.
export function issueDispositions(result) {
  const raw = result?.issueDispositions;
  if (!Array.isArray(raw)) return null;
  const entries = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const issueId = entry.issueId ?? entry.id ?? null;
    if (!issueId) continue;
    entries.push({
      issueId,
      disposition: entry.disposition ?? null,
      assignedTaskIds: Array.isArray(entry.assignedTaskIds)
        ? entry.assignedTaskIds.filter(id => typeof id === 'string' && id.length > 0)
        : [],
    });
  }
  return entries;
}

// authorshipResults: [{ taskId, result }] in flow order, as produced
// by authorshipResultsForBatch (sweep-accounting). Only the LAST
// completed result is judged, for the same reason as the sweep gate:
// a later repair result supersedes the decompose it repaired.
export function evaluateIssueAssignment({ requests, authorshipResults, draftTaskIds, liveTaskIds }) {
  const issueIds = triageIssueIds(requests);
  if (issueIds.length === 0) return { ok: true, missing: [], undispositioned: [], sourceTaskId: null };
  const completed = (authorshipResults ?? []).filter(item => item?.result != null);
  if (completed.length === 0) {
    return {
      ok: false, code: 'ISSUE_DISPOSITION_ABSENT', sourceTaskId: null,
      missing: [], undispositioned: issueIds,
      error: 'no completed Tech Lead authorship result in this batch is available to carry the issue dispositions',
    };
  }
  const last = completed[completed.length - 1];
  const entries = issueDispositions(last.result);
  if (!entries || entries.length === 0) {
    return {
      ok: false, code: 'ISSUE_DISPOSITION_ABSENT', sourceTaskId: last.taskId,
      missing: [], undispositioned: issueIds,
      error: `the latest Tech Lead result (${last.taskId}) carries no issueDispositions - every issue triaged in this batch must be dispositioned in result.issueDispositions of the batch's final Tech Lead result`,
    };
  }
  const byIssue = new Map(entries.map(entry => [entry.issueId, entry]));
  const undispositioned = issueIds.filter(id => !byIssue.has(id));
  if (undispositioned.length > 0) {
    return {
      ok: false, code: 'ISSUE_DISPOSITION_MISSING', sourceTaskId: last.taskId,
      missing: [], undispositioned,
      error: `the issue dispositions in ${last.taskId} do not cover every issue triaged in this batch - missing: ${undispositioned.join(', ')}`,
    };
  }
  const known = new Set([...(draftTaskIds ?? []), ...(liveTaskIds ?? [])]);
  const missing = [];
  for (const issueId of issueIds) {
    const absent = byIssue.get(issueId).assignedTaskIds.filter(id => !known.has(id));
    if (absent.length > 0) missing.push({ issueId, taskIds: absent });
  }
  if (missing.length > 0) {
    const detail = missing.map(item => `${item.issueId} -> ${item.taskIds.join(', ')}`).join('; ');
    return {
      ok: false, code: 'ISSUE_ASSIGNMENT_UNVERIFIED', sourceTaskId: last.taskId,
      missing, undispositioned: [],
      error: `the issue dispositions in ${last.taskId} claim assigned tasks that exist neither in the draft nor among the project's live tasks - ${detail}. Create the task for real (ariad_insert_fix_task for the issue queue, or ariad_tree_patch into the draft) or correct the claimed IDs`,
    };
  }
  return { ok: true, missing: [], undispositioned: [], sourceTaskId: last.taskId };
}
