import { TASK_KINDS } from './control-task-policy.js';

// Platform-defect escalation (owner decision, 2026-11-27): a defect in
// Ariad itself is not project work. It never enters Tech Lead triage -
// the project cannot repair the platform, and queueing the report only
// lets it rot unassigned (SRPG accumulated a dozen such issues). A
// platform report instead raises a human gate immediately: a HUMAN_GATE
// task born in NEEDS_HUMAN, surfaced by project status and decidable
// through the ordinary submitDecision path. The decision closes the
// gate (gate tasks resolve NEEDS_HUMAN -> DONE on HUMAN_DECISION) and
// is recorded on the issue, which then leaves the project's hands.

export function escalatePlatformIssue(store, issue) {
  if (!issue || issue.target !== 'platform') {
    throw new Error('PLATFORM_GATE_REQUIRES_PLATFORM_ISSUE');
  }
  const existing = issue.gateTaskId ? store.getTask(issue.gateTaskId) : null;
  if (issue.state === 'NEEDS_HUMAN' && existing && existing.state === 'NEEDS_HUMAN') {
    return { issue, gate: existing, created: false };
  }
  let gateId = `human-gate:${issue.id}`;
  let suffix = 1;
  while (store.getTask(gateId)) {
    suffix += 1;
    gateId = `human-gate:${issue.id}:r${suffix}`;
  }
  const gate = store.createTask({
    id: gateId,
    projectId: issue.projectId,
    taskKind: TASK_KINDS.HUMAN_GATE,
    flowId: `human-gate:${issue.id}`,
    stage: 'human',
    state: 'NEEDS_HUMAN',
    title: `Platform defect: ${issue.title}`,
    input: {
      issueId: issue.id,
      target: 'platform',
      reportedBy: issue.reportedBy ?? null,
      sourceTaskId: issue.sourceTaskId ?? null,
      questions: [
        `Platform defect reported by ${issue.reportedBy ?? 'a project role'} - ${issue.title}: ${issue.description}`,
      ],
    },
    history: [{ type: 'PLATFORM_ISSUE_ESCALATED', issueId: issue.id, at: new Date().toISOString() }],
  });
  const updated = store.updateIssue(issue.id, { state: 'NEEDS_HUMAN', gateTaskId: gate.id });
  return { issue: updated, gate, created: true };
}

export function recordPlatformGateDecision(store, gateTask, decision) {
  const issueId = gateTask?.input?.issueId;
  if (!issueId) return null;
  const issue = store.getIssue(issueId);
  if (!issue) return null;
  return store.updateIssue(issueId, {
    state: 'HUMAN_DECIDED',
    humanDecision: { decision, gateTaskId: gateTask.id, at: new Date().toISOString() },
  });
}
