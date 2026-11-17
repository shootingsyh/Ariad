import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triageIssueIds,
  issueDispositions,
  evaluateIssueAssignment,
} from '../src/v2/issue-assignment.js';

const ISSUE = 'issue:srpg:troops-down-frame-768-vs-512-dimension-gate';
const REQ = [{ request: { purpose: 'TRIAGE_AND_ASSIGN_ISSUE', issueId: ISSUE } }];
const authored = (result, taskId = 'planner:batch-1:decompose') => [{ taskId, result }];

test('triageIssueIds: triage requests only, deduped, null-safe', () => {
  assert.deepEqual(triageIssueIds(REQ), [ISSUE]);
  assert.deepEqual(triageIssueIds([{ request: { purpose: 'LOCAL_REPLAN' } }]), []);
  assert.deepEqual(triageIssueIds([{ request: { purpose: 'TRIAGE_AND_ASSIGN_ISSUE', issue: { id: 'issue:x' } } }]), ['issue:x']);
  assert.deepEqual(triageIssueIds([...REQ, ...REQ]), [ISSUE]);
  assert.deepEqual(triageIssueIds(null), []);
  assert.deepEqual(triageIssueIds([]), []);
});

test('issueDispositions: normalizes the emitted shape, null when absent', () => {
  assert.equal(issueDispositions(null), null);
  assert.equal(issueDispositions({}), null);
  assert.equal(issueDispositions({ issueDispositions: 'nope' }), null);
  const entries = issueDispositions({
    issueDispositions: [
      { issueId: ISSUE, disposition: 'ACCEPTED_VALID_DEFECT', assignedTaskIds: ['T-fix-a', 42, ''] },
      { disposition: 'REJECTED' },
      'garbage',
    ],
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].assignedTaskIds, ['T-fix-a']);
});

test('evaluateIssueAssignment: no triage requests is a no-op pass', () => {
  const v = evaluateIssueAssignment({ requests: [], authorshipResults: [], draftTaskIds: [], liveTaskIds: [] });
  assert.equal(v.ok, true);
});

test('evaluateIssueAssignment: claim resolving in the draft passes (tree route)', () => {
  const v = evaluateIssueAssignment({
    requests: REQ,
    authorshipResults: authored({ issueDispositions: [{ issueId: ISSUE, disposition: 'ACCEPTED_VALID_DEFECT', assignedTaskIds: ['T-fix-troops-down-dimension-gate'] }] }),
    draftTaskIds: ['I-root', 'T-fix-troops-down-dimension-gate'],
    liveTaskIds: ['I-root'],
  });
  assert.equal(v.ok, true);
});

test('evaluateIssueAssignment: claim resolving among live tasks passes (issue-queue route)', () => {
  const v = evaluateIssueAssignment({
    requests: REQ,
    authorshipResults: authored({ issueDispositions: [{ issueId: ISSUE, disposition: 'ACCEPTED_VALID_DEFECT', assignedTaskIds: ['fix-troops-down'] }] }),
    draftTaskIds: ['I-root'],
    liveTaskIds: ['I-root', 'fix-troops-down'],
  });
  assert.equal(v.ok, true);
});

test('evaluateIssueAssignment: the batch-79 failure - claimed task exists nowhere', () => {
  const v = evaluateIssueAssignment({
    requests: REQ,
    authorshipResults: authored({ issueDispositions: [{ issueId: ISSUE, disposition: 'ACCEPTED_VALID_DEFECT', assignedTaskIds: ['T-fix-troops-down-dimension-gate'] }] }),
    draftTaskIds: ['I-root', 'T-battle'],
    liveTaskIds: ['I-root', 'T-battle'],
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'ISSUE_ASSIGNMENT_UNVERIFIED');
  assert.deepEqual(v.missing, [{ issueId: ISSUE, taskIds: ['T-fix-troops-down-dimension-gate'] }]);
  assert.match(v.error, /T-fix-troops-down-dimension-gate/);
});

test('evaluateIssueAssignment: rejection without assignees needs no carrier', () => {
  const v = evaluateIssueAssignment({
    requests: REQ,
    authorshipResults: authored({ issueDispositions: [{ issueId: ISSUE, disposition: 'REJECTED_DUPLICATE', assignedTaskIds: [] }] }),
    draftTaskIds: [], liveTaskIds: [],
  });
  assert.equal(v.ok, true);
});

test('evaluateIssueAssignment: undispositioned issue fails', () => {
  const v = evaluateIssueAssignment({
    requests: REQ,
    authorshipResults: authored({ issueDispositions: [{ issueId: 'issue:other', disposition: 'REJECTED' }] }),
    draftTaskIds: [], liveTaskIds: [],
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'ISSUE_DISPOSITION_MISSING');
  assert.deepEqual(v.undispositioned, [ISSUE]);
});

test('evaluateIssueAssignment: absent dispositions fail', () => {
  const v1 = evaluateIssueAssignment({ requests: REQ, authorshipResults: authored({ plannedTaskIds: [] }), draftTaskIds: [], liveTaskIds: [] });
  assert.equal(v1.ok, false);
  assert.equal(v1.code, 'ISSUE_DISPOSITION_ABSENT');
  const v2 = evaluateIssueAssignment({ requests: REQ, authorshipResults: [], draftTaskIds: [], liveTaskIds: [] });
  assert.equal(v2.ok, false);
  assert.equal(v2.code, 'ISSUE_DISPOSITION_ABSENT');
});

test('evaluateIssueAssignment: only the last authorship result is judged', () => {
  const ghost = { issueDispositions: [{ issueId: ISSUE, disposition: 'ACCEPTED_VALID_DEFECT', assignedTaskIds: ['T-ghost'] }] };
  const fixed = { issueDispositions: [{ issueId: ISSUE, disposition: 'ACCEPTED_VALID_DEFECT', assignedTaskIds: ['T-real'] }] };
  const repaired = evaluateIssueAssignment({
    requests: REQ,
    authorshipResults: [{ taskId: 'planner:batch-1:decompose', result: ghost }, { taskId: 'planner:batch-1:repair-1', result: fixed }],
    draftTaskIds: ['T-real'], liveTaskIds: [],
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.sourceTaskId, 'planner:batch-1:repair-1');
  const regressed = evaluateIssueAssignment({
    requests: REQ,
    authorshipResults: [{ taskId: 'planner:batch-1:decompose', result: fixed }, { taskId: 'planner:batch-1:repair-1', result: ghost }],
    draftTaskIds: ['T-real'], liveTaskIds: [],
  });
  assert.equal(regressed.ok, false);
  assert.equal(regressed.code, 'ISSUE_ASSIGNMENT_UNVERIFIED');
});
