import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { executorTransitionFromResult } from '../src/v2/role-executor-transition.js';
import { RoleResultDispatcher } from '../src/v2/role-result-dispatcher.js';
import { ensureInterfaceArtifactLayout } from '../src/v2/interface-contracts.js';

// Escalation whitelist, executor layer: planning-stage failures retry at
// the tech lead, then route to the project debugger, and only a terminal
// debugger diagnosis may surface - as SYSTEM_BLOCKED (system dead), never
// as a per-task human decision.

test('executor terminal mapping: planning machines block, delivery still parks for diagnosis', () => {
  const planDebugger = { taskKind: 'PLANNING', stage: 'project_debugger' };
  assert.equal(executorTransitionFromResult(planDebugger, 'NEEDS_HUMAN').patch.state, 'SYSTEM_BLOCKED');
  const subPlanDebugger = { taskKind: 'NODE_PLANNING', stage: 'project_debugger', input: {} };
  assert.equal(executorTransitionFromResult(subPlanDebugger, 'NEEDS_HUMAN').patch.state, 'SYSTEM_BLOCKED');
  const deliveryDebugger = { taskKind: 'FEATURE_TASK', stage: 'project_debugger' };
  assert.equal(executorTransitionFromResult(deliveryDebugger, 'NEEDS_HUMAN').patch.state, 'NEEDS_HUMAN');
  const pmTask = { taskKind: 'PLANNING', stage: 'pm' };
  assert.equal(executorTransitionFromResult(pmTask, 'HUMAN_GATE').patch.state, 'NEEDS_HUMAN');
});

test('planning gate failures retry at the tech lead twice, then route to the debugger', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const base = { id: 'v', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', history: [] };
  const fail = { outcome: 'FAIL', result: { error: 'bad plan' } };
  const first = roles.plan_validator.transition({ task: { ...base, input: { purpose: 'PLANNER_FINAL_VALIDATE', planGateRetries: 0 } }, result: fail });
  assert.equal(first.state, 'READY');
  assert.equal(first.stage, 'tech_lead');
  assert.equal(first.transitionHistory.type, 'PLAN_GATE_RETRY');
  assert.equal(first.input.planGateRetries, 1);
  const exhausted = roles.plan_validator.transition({ task: { ...base, input: { purpose: 'PLANNER_FINAL_VALIDATE', planGateRetries: 2 } }, result: fail });
  assert.equal(exhausted.state, 'READY');
  assert.equal(exhausted.stage, 'project_debugger');
  assert.equal(exhausted.transitionHistory.type, 'PLAN_DEBUGGER_ROUTED');
});

test('planning debugger: one guided recovery, then a terminal SYSTEM_BLOCKED diagnosis', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const task = { id: 'd', projectId: 'P', taskKind: 'PLANNING', stage: 'project_debugger', input: {}, history: [] };
  const repaired = roles.project_debugger.transition({ task, result: { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Split the interface stage.' } } });
  assert.equal(repaired.state, 'READY');
  assert.equal(repaired.stage, 'tech_lead');
  assert.equal(repaired.transitionHistory.type, 'PLAN_DEBUGGER_RECOVERY');
  const diagnosed = roles.project_debugger.transition({ task, result: { outcome: 'UNKNOWN_PROJECT_CAUSE', summary: 'No viable repair.' } });
  assert.equal(diagnosed.state, 'SYSTEM_BLOCKED');
  assert.equal(diagnosed.transitionHistory.type, 'PLAN_DEBUGGER_DIAGNOSIS');
  const secondRecovery = roles.project_debugger.transition({
    task: { ...task, input: { planDebuggerRecoveryCount: 1 } },
    result: { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Try again.' } },
  });
  assert.equal(secondRecovery.state, 'SYSTEM_BLOCKED');
});

test('dispatcher persists a planning debugger diagnosis as SYSTEM_BLOCKED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-plan-block-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: false, spec: 'x' });
    store.enqueuePlanningRequest({ id: 'r1', projectId: 'P', request: { purpose: 'INITIAL_PLAN' } });
    store.createPlanningBatch({
      projectId: 'P', batchId: 'b1', requestIds: ['r1'],
      tasks: [{ id: 'DBG', stage: 'tech_lead', state: 'DONE', input: {} }],
    });
    // Runtime stage changes bypass creation-time validation (a debugger
    // stage belongs to DIAGNOSTIC tasks at creation); move the task the
    // way a transition patch would, with its debugger result attached.
    const seeded = store.getTask('DBG');
    store.appendTaskHistory('DBG', seeded.version,
      { type: 'ROLE_RESULT', role: 'project_debugger', outcome: 'UNKNOWN_PROJECT_CAUSE', summary: 'No viable repair.' },
      { stage: 'project_debugger', state: 'RESULT_READY', input: {} });
    const definitions = createDefaultV2Roles({ store, workspace: dir, artifactRoot: join(dir, '.ariad', 'artifacts'), providerId: 'fake', codeProviderId: 'ariad-code' });
    const roles = { get: name => definitions[name] };
    await new RoleResultDispatcher({ store, roles }).advanceResults('P');
    assert.equal(store.getTask('DBG').state, 'SYSTEM_BLOCKED');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('planning debugger prepare surfaces the gate failure detail', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const task = {
    id: 'dbg1', projectId: 'P', taskKind: 'PLANNING', stage: 'project_debugger', history: [],
    input: { previousGateFailure: { stage: 'tech_lead', blockedType: 'ARTIFACT_VALIDATION_FAILED', summary: 'boom | unparseable planner artifacts: planner/milestones/M1.json' } },
  };
  const prepared = roles.project_debugger.prepare({ task });
  assert.match(JSON.stringify(prepared), /ARTIFACT_VALIDATION_FAILED/);
  assert.match(JSON.stringify(prepared), /M1\.json/);
});

test('final validation failure enters the counted gate ladder', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const base = { id: 'fv', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', history: [] };
  const fail = { outcome: 'NOT_PASS', result: { valid: false, error: 'NO_OPEN_DRAFT: no draft', errorCode: 'NO_OPEN_DRAFT' } };
  const first = roles.plan_validator.transition({ task: { ...base, input: { purpose: 'PLANNER_FINAL_VALIDATE', planGateRetries: 0 } }, result: fail });
  assert.equal(first.state, 'READY');
  assert.equal(first.stage, 'tech_lead');
  assert.equal(first.transitionHistory.type, 'PLAN_GATE_RETRY');
  assert.equal(first.input.planGateRetries, 1);
});

test('tech lead repair on a gate task returns it to the gate, never DONE', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const tl = { id: 'g', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', history: [] };
  const repaired = { outcome: 'PLANNED', summary: 'ok' };
  const backToValidator = roles.tech_lead.transition({ task: { ...tl, input: { purpose: 'PLANNER_FINAL_VALIDATE', planGateRetries: 1 } }, result: repaired });
  assert.equal(backToValidator.state, 'READY');
  assert.equal(backToValidator.stage, 'plan_validator');
  assert.equal(backToValidator.transitionHistory.type, 'GATE_REPAIR_RETURNED');
  const backToPm = roles.tech_lead.transition({ task: { ...tl, input: { purpose: 'PLANNER_PM_REVIEW', planGateRetries: 1 } }, result: repaired });
  assert.equal(backToPm.state, 'READY');
  assert.equal(backToPm.stage, 'pm');
  // A non-gate planning repair still completes as before.
  const ordinary = roles.tech_lead.transition({ task: { ...tl, input: { purpose: 'PLANNER_REPAIR' } }, result: repaired });
  assert.equal(ordinary.state, 'DONE');
});

test('gate loop terminates: repeated validation failure reaches the debugger', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const fail = { outcome: 'NOT_PASS', result: { valid: false, error: 'still bad', errorCode: 'X' } };
  const second = roles.plan_validator.transition({
    task: { id: 'fv2', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', history: [], input: { purpose: 'PLANNER_FINAL_VALIDATE', planGateRetries: 1 } },
    result: fail,
  });
  assert.equal(second.stage, 'tech_lead');
  assert.equal(second.input.planGateRetries, 2);
  const exhausted = roles.plan_validator.transition({
    task: { id: 'fv3', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', history: [], input: { purpose: 'PLANNER_FINAL_VALIDATE', planGateRetries: 2 } },
    result: fail,
  });
  assert.equal(exhausted.stage, 'project_debugger');
  assert.equal(exhausted.transitionHistory.type, 'PLAN_DEBUGGER_ROUTED');
});

import { VersionedStore } from '../src/v2/versioned-store.js';

test('versioned decompose without a DB draft is rejected at submission, not at the gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-nodraft-'));
  const file = join(dir, 'state2.db');
  const vs = new VersionedStore(file);
  vs.initProject('P');
  vs.close();
  const store = { filePath: file, getProject: () => ({ id: 'P', versionedTree: true, workspace: dir }) };
  const roles = createDefaultV2Roles({ store, workspace: dir });
  const out = roles.tech_lead.transition({
    task: { id: 'd1', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', history: [], input: { purpose: 'PLANNER_DECOMPOSE', planGateRetries: 0 } },
    result: { outcome: 'PLANNED', summary: 'plan ready', result: null },
  });
  assert.equal(out.state, 'READY');
  assert.equal(out.stage, 'tech_lead');
  assert.equal(out.transitionHistory.type, 'PLAN_GATE_RETRY');
  assert.equal(out.input.previousGateFailure.blockedType, 'TL_PLAN_WITHOUT_DRAFT');
});

import { recordRequirementsApproval } from '../src/v2/project-docs.js';

test('versioned decompose is bounced at submission when requirements are missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-reqgate-'));
  mkdirSync(join(dir, '.ariad', 'docs'), { recursive: true });
  const file = join(dir, 'state2.db');
  const vs = new VersionedStore(file);
  vs.initProject('P');
  vs.close();
  const store = { filePath: file, getProject: () => ({ id: 'P', versionedTree: true, workspace: dir }) };
  const roles = createDefaultV2Roles({ store, workspace: dir });
  const out = roles.tech_lead.transition({
    task: { id: 'd2', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', history: [], input: { purpose: 'PLANNER_DECOMPOSE', planGateRetries: 0 } },
    result: { outcome: 'PLANNED', summary: 'plan ready', result: null },
  });
  // The requirements gate is a deliberate human channel, not machinery
  // failure: it parks NEEDS_HUMAN without consuming gate retries, and it
  // still parks (never routes to the debugger) when retries are spent.
  assert.equal(out.state, 'NEEDS_HUMAN');
  assert.equal(out.transitionHistory.type, 'REQUIREMENTS_GATE');
  const exhausted = roles.tech_lead.transition({
    task: { id: 'd2b', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', history: [], input: { purpose: 'PLANNER_DECOMPOSE', planGateRetries: 2 } },
    result: { outcome: 'PLANNED', summary: 'plan ready', result: null },
  });
  assert.equal(exhausted.state, 'NEEDS_HUMAN');
  assert.equal(exhausted.transitionHistory.type, 'REQUIREMENTS_GATE');
});

test('approved requirements let the decompose submission reach the draft check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-reqok-'));
  mkdirSync(join(dir, '.ariad', 'docs'), { recursive: true });
  writeFileSync(join(dir, '.ariad', 'docs', 'REQUIREMENTS.md'), '# Requirements\n\nBaseline.\n');
  recordRequirementsApproval(dir, { approvedBy: 'test' });
  const file = join(dir, 'state2.db');
  const vs = new VersionedStore(file);
  vs.initProject('P');
  vs.close();
  const store = { filePath: file, getProject: () => ({ id: 'P', versionedTree: true, workspace: dir }) };
  const roles = createDefaultV2Roles({ store, workspace: dir });
  const out = roles.tech_lead.transition({
    task: { id: 'd3', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', history: [], input: { purpose: 'PLANNER_DECOMPOSE', planGateRetries: 0 } },
    result: { outcome: 'PLANNED', summary: 'plan ready', result: null },
  });
  assert.equal(out.input.previousGateFailure.blockedType, 'TL_PLAN_WITHOUT_DRAFT');
});

import { plannerFlowTasks } from '../src/v2/planner-flow.js';

test('requirements authoring request becomes a single PM stage', () => {
  const tasks = plannerFlowTasks('batch-r', [{ id: 'requirements:P', request: { purpose: 'REQUIREMENTS_AUTHORING', instruction: 'Author it.' }, context: { bootstrap: true } }]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].stage, 'pm');
  assert.equal(tasks[0].input.purpose, 'REQUIREMENTS_AUTHORING');
});

test('PM requirements stage parks for human review with questions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-reqstage-'));
  const store = { filePath: join(dir, 'state2.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G' }) };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const out = roles.pm.transition({
    task: { id: 'r1', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'REQUIREMENTS_AUTHORING', planningBatchId: 'b1' } },
    result: { outcome: 'NEEDS_HUMAN', summary: 'doc ready', result: { questions: ['Please review REQUIREMENTS.md and approve it.'] } },
  });
  assert.equal(out.state, 'NEEDS_HUMAN');
  assert.equal(out.transitionHistory.type, 'PM_HUMAN_DECISION');
  assert.deepEqual(out.transitionHistory.questions, ['Please review REQUIREMENTS.md and approve it.']);
});

test('approved requirements close the PM stage and enqueue initial planning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-reqdone-'));
  mkdirSync(join(dir, '.ariad', 'docs'), { recursive: true });
  writeFileSync(join(dir, '.ariad', 'docs', 'REQUIREMENTS.md'), '# Requirements\n\nBaseline.\n');
  recordRequirementsApproval(dir, { approvedBy: 'test' });
  const enqueued = [];
  const store = { filePath: join(dir, 'state2.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G' }) };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: arg => enqueued.push(arg) });
  const out = roles.pm.transition({
    task: { id: 'r2', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'REQUIREMENTS_AUTHORING', planningBatchId: 'b1' } },
    result: { outcome: 'PLAN_ACCEPTED', summary: 'approved', result: { startDelivery: false } },
  });
  assert.equal(out.state, 'DONE');
  assert.equal(out.transitionHistory.type, 'REQUIREMENTS_FINALIZED');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].request.purpose, 'INITIAL_PLAN');
});

test('PM requirements-authoring prompt carries the document standards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-reqprompt-'));
  const store = { filePath: join(dir, 'state2.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G' }) };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const prepared = roles.pm.prepare({
    project: { id: 'P', workspace: dir, mode: 'TAKEOVER', goal: 'G' },
    task: { id: 'r3', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'REQUIREMENTS_AUTHORING', planningBatchId: 'b1', requests: [] } },
  });
  const prompt = prepared.context.v2Prompt;
  assert.match(prompt, /delta section stating ONLY what this version adds, changes, or removes/);
  assert.match(prompt, /must not recount, list, or summarize what the previous version already implemented/);
  assert.match(prompt, /no numeric tuning values, no mechanic formulas or constants/);
  assert.match(prompt, /present-tense product description/);
});

test('debug hold parks the PM plan review for the human, never the failure ladder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-debughold-'));
  const store = { filePath: join(dir, 'state2.db'), getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD', takeoverReviewRequired: false }), updateProject: () => ({}) };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {}, debugHoldAfterPlanReview: true });
  const accept = { outcome: 'PLAN_ACCEPTED', summary: 'plan accepted', result: { reason: 'Plan covers the approved requirements.', startDelivery: true } };
  const out = roles.pm.transition({
    task: { id: 'pr1', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'PLANNER_PM_REVIEW', planningBatchId: 'b2', planGateRetries: 0 } },
    result: accept,
  });
  // The debug hold is a deliberate human channel, not machinery failure:
  // it parks NEEDS_HUMAN without consuming gate retries, and it still
  // parks (never routes to the debugger) when retries are spent. The
  // 2026-10-31 SRPG halt laddered the hold to SYSTEM_BLOCKED and parked
  // the whole project FAILED because DEBUG_HOLD was missing here.
  assert.equal(out.state, 'NEEDS_HUMAN');
  assert.equal(out.transitionHistory.type, 'DEBUG_HOLD');
  const exhausted = roles.pm.transition({
    task: { id: 'pr2', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', history: [], input: { purpose: 'PLANNER_PM_REVIEW', planningBatchId: 'b2', planGateRetries: 2 } },
    result: accept,
  });
  assert.equal(exhausted.state, 'NEEDS_HUMAN');
  assert.equal(exhausted.transitionHistory.type, 'DEBUG_HOLD');
});
