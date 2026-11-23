import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { criticPrompt, planPayloadFromStore } from '../src/v2/role-prompts.js';
import { buildTechLeadPrompt } from '../src/v2/tech-lead-prompt.js';
import { VersionedStore } from '../src/v2/versioned-store.js';

// Plan-fidelity regression (2026-11-01, SRPG art iteration): the PM
// accepted a draft whose presentation tasks were regression-only and
// whose acceptance criteria diluted the approved requirements (full
// action sets became "no placeholders"), and neither the critic nor
// the PM could have caught it from what the system showed them:
//  - the DB-first validator PASS payload was a stub {source, version,
//    taskCount}, so neither reviewer ever saw a task spec (fixed at the
//    time by embedding the plan in the result; superseded 2026-11-22 -
//    the reviewers' payloads are now assembled from the store by
//    version at dispatch time and the result is a stub again by
//    design: the plan lives in the store, not inside the task.
//    Later the same day the payload itself went diff-only: it
//    carries the diff and names a workspace file holding the full
//    draft text, which reviewers read on demand);
//  - the PM review prompt judged coverage from summaries and carried
//    no fidelity standard (production vs verification, enumeration
//    completeness, art/ux markings);
//  - the TL prompt asked for a media gap analysis but never required
//    an auditable per-requirement disposition in the plan result.
// These tests pin all three fixes.

test('plan validator PASS result is a stub; the reviewer payload carries the diff and names the draft file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-planpayload-'));
  const dbPath = join(dir, 'state.db');
  const vs = new VersionedStore(dbPath);
  vs.initProject('P');
  vs.createDraft({ createdBy: 'tl' });
  vs.applyTreeOps([
    { op: 'upsertContract', contract: { id: 'feature.alpha', nodeType: 'feature', exportedInterfaces: [{ id: 'alpha_api' }], behavior: ['Alpha behaves.'] } },
    { op: 'upsertTask', task: { id: 'a-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Alpha task', acceptanceCriteria: ['Alpha does the thing, all three variants'], executionMode: 'direct' } },
  ]);
  vs.close();
  const store = { filePath: dbPath, getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD' }) };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const prepared = roles.plan_validator.prepare({
    task: { id: 'v1', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', history: [], input: { purpose: 'PLANNER_VALIDATE' } },
  });
  const out = await prepared.execute();
  assert.equal(out.outcome, 'PASS');
  assert.equal(out.result.plan.source, 'db-draft');
  assert.equal(out.result.plan.taskCount, 1);
  assert.equal(typeof out.result.plan.diffHash, 'string');
  // The result archived in the task carries no copy of the tree.
  assert.equal(out.result.plan.tasks, undefined);
  assert.equal(out.result.plan.contracts, undefined);
  // Reviewers judge the diff, not the tree: the payload assembled
  // from the store carries no task/contract arrays. The full draft
  // text is in the workspace file the payload names (planFile).
  const payload = planPayloadFromStore(store, { workspace: dir }, out.result);
  assert.equal(payload.tasks, undefined);
  assert.equal(payload.contracts, undefined);
  assert.ok(payload.planFile);
  const draftFile = JSON.parse(readFileSync(join(dir, payload.planFile), 'utf8'));
  assert.equal(draftFile.tasks.length, 1);
  assert.equal(draftFile.tasks[0].id, 'a-task');
  assert.match(draftFile.tasks[0].acceptanceCriteria[0], /all three variants/);
  assert.equal(draftFile.contracts.length, 1);
  assert.equal(draftFile.contracts[0].id, 'feature.alpha');
  assert.equal(payload.diff.diffHash, out.result.plan.diffHash);
  assert.equal(payload.sweepAccounting.derived, true);
});

test('PM plan-review prompt carries the fidelity standard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-pmfidelity-'));
  const fv = { id: 'fv1', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', flowId: 'flow-1', history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { plan: { tasks: [] } } }] };
  const pmTask = { id: 'pr9', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', flowId: 'flow-1', dependsOn: ['fv1'], history: [], input: { purpose: 'PLANNER_PM_REVIEW', planningBatchId: 'b9' } };
  const store = { filePath: join(dir, 'state.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD', takeoverReviewRequired: false }), updateProject: () => ({}), listTasks: () => [fv, pmTask], listAllTasks: () => [fv, pmTask], listTasksByStates: () => [fv, pmTask], listTasksByFlow: () => [fv, pmTask], listTasksByScope: () => [fv, pmTask], listPlanningRequests: () => [] };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const prepared = roles.pm.prepare({ project: { id: 'P', workspace: dir, mode: 'STANDARD' }, task: pmTask });
  const prompt = prepared.context.v2Prompt;
  assert.match(prompt, /PLAN FIDELITY/);
  assert.match(prompt, /carried only by verification or regression wording/);
  assert.match(prompt, /covered only in part is not covered/);
  assert.match(prompt, /ux\.required/);
  assert.match(prompt, /accepting on their summaries alone is a review failure/);
  assert.match(prompt, /ACCOUNTING - YOUR RESULT MUST CARRY THE TRACE ITSELF/);
  assert.match(prompt, /clause granularity/);
  assert.match(prompt, /expression or scar variant/);
  assert.match(prompt, /EXISTING TASK SWEEP/);
  assert.match(prompt, /SWEEP ACCOUNTING/);
});

test('batch critic prompt carries the fidelity review', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'ariad-critic-fidelity-'));
  const flow = 'planner:P:batch-9-9';
  const criticTask = {
    id: 'planner:batch-9-9:critic-1', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead_critic',
    flowId: flow, input: { planningBatchId: 'batch-9-9', purpose: 'PLANNER_CRITIC', round: 1 },
    dependsOn: ['planner:batch-9-9:validate-1'], history: [],
  };
  const validate = {
    id: 'planner:batch-9-9:validate-1', projectId: 'P', flowId: flow,
    history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { plan: { source: 'db-draft', version: 1, taskCount: 0, tasks: [], contracts: [] } } }],
  };
  const store = { listPlanningRequests: () => [], listTasks: () => [validate, criticTask], listAllTasks: () => [validate, criticTask], listTasksByStates: () => [validate, criticTask], listTasksByFlow: () => [validate, criticTask], listTasksByScope: () => [validate, criticTask]};
  const prompt = criticPrompt({ store, project: { id: 'P', spec: 'spec' }, task: criticTask, artifactRoot });
  assert.match(prompt, /FIDELITY TO THE APPROVED REQUIREMENTS/);
  assert.match(prompt, /covered only in part is not covered/);
  assert.match(prompt, /gap-analysis disposition/);
  assert.match(prompt, /Granularity is part of fidelity/);
});

test('tech lead prompt requires an auditable gap disposition and acceptance fidelity', () => {
  const prompt = buildTechLeadPrompt({ projectContext: {}, schema: null });
  assert.match(prompt, /SATISFIED-BY-EXISTING/);
  assert.match(prompt, /never silently default to regression-only/);
  assert.match(prompt, /per enumerated clause, not per section headline/);
  assert.match(prompt, /Acceptance fidelity/);
  assert.match(prompt, /could pass its own acceptance criteria while the requirement it carries is unmet/);
});

// PM revision-loop regression (2026-11-01, SRPG): plan review ran in the
// PM persistent authoring session, anchored on its own earlier traces,
// and re-demanded clauses verbatim that the validated plan had carried
// since an earlier round; with no convergence bound the cycle burned
// nine full revision rounds. These tests pin the two fixes: a fresh
// session per review task, and a revision-round cap that parks for a
// human decision instead of replanning forever.

test('PM plan review uses a fresh session per review task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-pmnewsession-'));
  const fv = { id: 'fv1', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', flowId: 'flow-1', history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { plan: { tasks: [] } } }] };
  const store = { filePath: join(dir, 'state.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD', takeoverReviewRequired: false }), updateProject: () => ({}), listTasks: () => [fv], listAllTasks: () => [fv], listTasksByStates: () => [fv], listTasksByFlow: () => [fv], listTasksByScope: () => [fv], listPlanningRequests: () => [] };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const mkTask = id => ({ id, projectId: 'P', taskKind: 'PLANNING', stage: 'pm', flowId: 'flow-1', dependsOn: ['fv1'], history: [], input: { purpose: 'PLANNER_PM_REVIEW', planningBatchId: 'b' } });
  const first = roles.pm.prepare({ project: { id: 'P', workspace: dir, mode: 'STANDARD' }, task: mkTask('planner:batch-1-1:pm-review') });
  const second = roles.pm.prepare({ project: { id: 'P', workspace: dir, mode: 'STANDARD' }, task: mkTask('planner:batch-2-2:pm-review') });
  assert.equal(first.context.sessionKey, 'pm-review:P:planner:batch-1-1:pm-review');
  assert.equal(second.context.sessionKey, 'pm-review:P:planner:batch-2-2:pm-review');
  assert.notEqual(first.context.sessionKey, second.context.sessionKey);
});

test('PM revision below the cap enqueues another revision round', () => {
  const enqueued = [];
  const store = { listPlanningRequests: () => [{ request: { purpose: 'PM_PLAN_REVISION' } }, { request: { purpose: 'PM_PLAN_REVISION' } }] };
  const roles = createDefaultV2Roles({ store, workspace: '/tmp', enqueuePlanning: req => enqueued.push(req) });
  const task = { id: 'planner:batch-3-3:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'PLANNER_PM_REVIEW' } };
  const out = roles.pm.transition({ task, result: { outcome: 'PLAN_REVISION_REQUIRED', result: { guidance: 'fix the carriers', reason: 'gaps remain' } } });
  assert.equal(out.state, 'DONE');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].request.purpose, 'PM_PLAN_REVISION');
});

test('PM revision at the cap parks for a human decision instead of replanning', () => {
  const enqueued = [];
  const five = Array.from({ length: 5 }, () => ({ request: { purpose: 'PM_PLAN_REVISION' } }));
  const store = { listPlanningRequests: () => five };
  const roles = createDefaultV2Roles({ store, workspace: '/tmp', enqueuePlanning: req => enqueued.push(req) });
  const task = { id: 'planner:batch-6-6:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'PLANNER_PM_REVIEW' } };
  const out = roles.pm.transition({ task, result: { outcome: 'PLAN_REVISION_REQUIRED', result: { guidance: 'still gaps', reason: 'not converged' } } });
  assert.equal(out.state, 'NEEDS_HUMAN');
  assert.equal(out.transitionHistory.type, 'PM_HUMAN_DECISION');
  assert.equal(out.transitionHistory.questions.length, 1);
  assert.match(out.transitionHistory.summary, /not converged after 5 PM revision rounds/);
  assert.equal(enqueued.length, 0);
});

test('a human decision on the parked review re-authorizes further revision rounds', () => {
  const enqueued = [];
  const five = Array.from({ length: 5 }, () => ({ request: { purpose: 'PM_PLAN_REVISION' } }));
  const store = { listPlanningRequests: () => five };
  const roles = createDefaultV2Roles({ store, workspace: '/tmp', enqueuePlanning: req => enqueued.push(req) });
  const task = { id: 'planner:batch-6-6:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [{ type: 'HUMAN_DECISION', decision: 'Keep revising until it converges.' }], input: { purpose: 'PLANNER_PM_REVIEW' } };
  const out = roles.pm.transition({ task, result: { outcome: 'PLAN_REVISION_REQUIRED', result: { guidance: 'still gaps', reason: 'not converged' } } });
  assert.equal(out.state, 'DONE');
  assert.equal(enqueued.length, 1);
});

test('PM revision rounds reset after an acceptance: old rounds do not park a fresh draft', () => {
  const enqueued = [];
  const fiveOld = Array.from({ length: 5 }, (_, i) => ({ request: { purpose: 'PM_PLAN_REVISION' }, createdAt: '2026-11-01T0' + i + ':00:00.000Z' }));
  const accepted = { id: 'planner:batch-5-5:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [{ type: 'ROLE_RESULT', role: 'pm', outcome: 'PLAN_ACCEPTED', completedAt: '2026-11-01T09:00:00.000Z' }] };
  const store = { listPlanningRequests: () => fiveOld, listTasks: () => [accepted], listAllTasks: () => [accepted], listTasksByStates: () => [accepted], listTasksByFlow: () => [accepted], listTasksByScope: () => [accepted]};
  const roles = createDefaultV2Roles({ store, workspace: '/tmp', enqueuePlanning: req => enqueued.push(req) });
  const task = { id: 'planner:batch-6-6:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'PLANNER_PM_REVIEW' } };
  const out = roles.pm.transition({ task, result: { outcome: 'PLAN_REVISION_REQUIRED', result: { guidance: 'fix the carriers', reason: 'gaps remain' } } });
  assert.equal(out.state, 'DONE');
  assert.equal(enqueued.length, 1);
});

test('PM revision rounds since the last acceptance still park at the cap', () => {
  const enqueued = [];
  const accepted = { id: 'planner:batch-5-5:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [{ type: 'ROLE_RESULT', role: 'pm', outcome: 'PLAN_ACCEPTED', completedAt: '2026-11-01T09:00:00.000Z' }] };
  const fiveNew = Array.from({ length: 5 }, (_, i) => ({ request: { purpose: 'PM_PLAN_REVISION' }, createdAt: '2026-11-01T1' + i + ':00:00.000Z' }));
  const store = { listPlanningRequests: () => fiveNew, listTasks: () => [accepted], listAllTasks: () => [accepted], listTasksByStates: () => [accepted], listTasksByFlow: () => [accepted], listTasksByScope: () => [accepted]};
  const roles = createDefaultV2Roles({ store, workspace: '/tmp', enqueuePlanning: req => enqueued.push(req) });
  const task = { id: 'planner:batch-6-6:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'PLANNER_PM_REVIEW' } };
  const out = roles.pm.transition({ task, result: { outcome: 'PLAN_REVISION_REQUIRED', result: { guidance: 'still gaps', reason: 'not converged' } } });
  assert.equal(out.state, 'NEEDS_HUMAN');
  assert.equal(out.transitionHistory.type, 'PM_HUMAN_DECISION');
  assert.equal(enqueued.length, 0);
});

test('PM plan review inherits prior objections and all human decisions as payload data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-pminherit-'));
  const fv = { id: 'fv1', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', flowId: 'flow-1', history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { plan: { tasks: [] } } }] };
  const prior = { id: 'planner:batch-1-1:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', flowId: 'flow-0', input: { purpose: 'PLANNER_PM_REVIEW' }, history: [{ type: 'ROLE_RESULT', role: 'pm', outcome: 'PLAN_REVISION_REQUIRED', summary: 'prior summary', completedAt: '2026-11-01T00:00:00.000Z', result: { guidance: 'PRIOR GUIDANCE: enumerate the effects list verbatim' } }] };
  const decided = { id: 'planner:batch-0-0:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', flowId: 'flow-x', history: [{ type: 'HUMAN_DECISION', at: '2026-10-31T00:00:00.000Z', decision: 'Keep the scope to the approved delta only.' }] };
  const pmTask = { id: 'planner:batch-2-2:pm-review', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', flowId: 'flow-1', dependsOn: ['fv1'], history: [], input: { purpose: 'PLANNER_PM_REVIEW', planningBatchId: 'b2' } };
  const store = { filePath: join(dir, 'state.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD', takeoverReviewRequired: false }), updateProject: () => ({}), listTasks: () => [fv, prior, decided, pmTask], listAllTasks: () => [fv, prior, decided, pmTask], listTasksByStates: () => [fv, prior, decided, pmTask], listTasksByFlow: () => [fv, prior, decided, pmTask], listTasksByScope: () => [fv, prior, decided, pmTask], listPlanningRequests: () => [] };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const prepared = roles.pm.prepare({ project: { id: 'P', workspace: dir, mode: 'STANDARD' }, task: pmTask });
  const prompt = prepared.context.v2Prompt;
  assert.match(prompt, /INHERITED CONTEXT/);
  assert.match(prompt, /PRIOR GUIDANCE: enumerate the effects list verbatim/);
  assert.match(prompt, /Keep the scope to the approved delta only\./);
  assert.match(prompt, /never re-demand it/);
});

test('PM plan-review payload carries the derived sweep accounting and the plan diff (2026-11-22)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-pmsweep-'));
  const derived = { derived: true, entries: [{ taskId: 'T-battle', disposition: 'revised', reason: 'fields changed: acceptanceCriteria' }, { taskId: 'T-combat', disposition: 'non-conflicting', reason: 'unchanged by the draft' }] };
  const diff = { draftVersion: 8, baseVersion: 7, diffHash: 'abc123hash', tasks: { added: [], removed: [], changed: ['T-battle'] }, contracts: { added: [], removed: [], changed: [] }, detail: { tasks: { 'T-battle': { acceptanceCriteria: { from: ['old'], to: ['new'] } } }, contracts: {} } };
  const fv = { id: 'fv1', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', flowId: 'flow-1', history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { plan: { tasks: [], sweepAccounting: derived, diff } } }] };
  const decompose = { id: 'planner:b9:decompose', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', flowId: 'flow-1', input: { planningBatchId: 'b9', purpose: 'PLANNER_DECOMPOSE' }, history: [{ type: 'ROLE_RESULT', role: 'tech_lead', outcome: 'PLANNED', summary: 'drafted', result: {} }] };
  const pmTask = { id: 'pr9', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', flowId: 'flow-1', dependsOn: ['fv1'], history: [], input: { purpose: 'PLANNER_PM_REVIEW', planningBatchId: 'b9' } };
  const store = { filePath: join(dir, 'state.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD', takeoverReviewRequired: false }), updateProject: () => ({}), listTasks: () => [fv, pmTask, decompose], listAllTasks: () => [fv, pmTask, decompose], listTasksByStates: () => [fv, pmTask, decompose], listTasksByFlow: () => [fv, pmTask, decompose], listTasksByScope: () => [fv, pmTask, decompose], listPlanningRequests: () => [{ batchId: 'b9', request: { purpose: 'PM_PLAN_REVISION' } }] };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const prepared = roles.pm.prepare({ project: { id: 'P', workspace: dir, mode: 'STANDARD' }, task: pmTask });
  const prompt = prepared.context.v2Prompt;
  assert.match(prompt, /"sweepAccounting": \{/);
  assert.match(prompt, /"derived": true/);
  assert.match(prompt, /"taskId": "T-battle"/);
  assert.match(prompt, /"planDiff": \{/);
  assert.match(prompt, /"diffHash": "abc123hash"/);
  assert.match(prompt, /YOU APPROVE THE DIFF, NOT A SUMMARY OF IT/);
  assert.match(prompt, /result\.approvedDiffHash must carry the payload planDiff\.diffHash verbatim/);
});
