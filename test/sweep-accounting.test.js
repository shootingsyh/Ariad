import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchRequiresSweepAccounting,
  sweepAccountingEntries,
  sweepAccountingCoverage,
  evaluateSweepAccounting,
  authorshipResultsForBatch,
  sweepAccountingRaw,
} from '../src/v2/sweep-accounting.js';
import { plannerPrompt, criticPrompt } from '../src/v2/role-prompts.js';

const BASE = ['T-battle', 'T-combat', 'I-root'];

test('batchRequiresSweepAccounting: requirement-changing purposes only', () => {
  assert.equal(batchRequiresSweepAccounting([{ request: { purpose: 'PM_PLAN_REVISION' } }]), true);
  assert.equal(batchRequiresSweepAccounting([{ request: { purpose: 'LOCAL_REPLAN' } }]), true);
  assert.equal(batchRequiresSweepAccounting([{ request: { purpose: 'INITIAL_PLAN' } }]), true);
  assert.equal(batchRequiresSweepAccounting([{ request: { purpose: 'UPDATE_DELIVERY_PLAN' } }]), true);
  assert.equal(batchRequiresSweepAccounting([{ request: { purpose: 'TRIAGE_AND_ASSIGN_ISSUE' } }]), false);
  assert.equal(batchRequiresSweepAccounting([]), false);
  assert.equal(batchRequiresSweepAccounting(null), false);
});

test('sweepAccountingEntries: shapes Tech Lead sessions actually emit', () => {
  assert.equal(sweepAccountingEntries(null), null);
  assert.equal(sweepAccountingEntries({ draftVersion: 47 }), null);
  // Bucket shape (batch-27 style).
  const bucket = sweepAccountingEntries({
    sweepAccounting: {
      revised: [{ taskId: 'T-battle', reason: 'reworded' }],
      nonConflicting: ['T-combat'],
    },
  });
  assert.equal(bucket.length, 2);
  assert.equal(bucket[0].taskId, 'T-battle');
  // Flat prose lines (batch-52 style, under the alias key).
  const lines = sweepAccountingEntries({
    completeSweepAccounting: ['T-battle - REVISED: ...', 'T-combat - EXPLICITLY NON-CONFLICTING.'],
  });
  assert.equal(lines.length, 2);
  // Nested payload.
  const nested = sweepAccountingEntries({ result: { sweepAccounting: [{ taskId: 'I-root' }] } });
  assert.equal(nested.length, 1);
  assert.equal(nested[0].taskId, 'I-root');
});

test('sweepAccountingCoverage: hyphenated IDs need whole-token mentions', () => {
  const entries = sweepAccountingEntries({
    sweepAccounting: ['T-battle-hud-overlay - REVISED: only the longer ID is named'],
  });
  const covered = sweepAccountingCoverage(BASE, entries);
  assert.equal(covered.has('T-battle'), false);
  const entries2 = sweepAccountingEntries({
    sweepAccounting: ['T-battle - REVISED: named directly', { taskId: 'T-combat' }],
  });
  const covered2 = sweepAccountingCoverage(BASE, entries2);
  assert.equal(covered2.has('T-battle'), true);
  assert.equal(covered2.has('T-combat'), true);
  assert.equal(covered2.has('I-root'), false);
});

const fullAccounting = {
  sweepAccounting: {
    revised: [{ taskId: 'T-battle', reason: 'reworded' }],
    nonConflicting: [{ taskId: 'T-combat' }, { taskId: 'I-root' }],
  },
};

test('evaluateSweepAccounting: complete accounting in the only TL result passes', () => {
  const verdict = evaluateSweepAccounting({
    baseTaskIds: BASE,
    authorshipResults: [{ taskId: 'planner:b:decompose', result: fullAccounting }],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sourceTaskId, 'planner:b:decompose');
});

test('evaluateSweepAccounting: a later repair without accounting voids the decompose one', () => {
  const verdict = evaluateSweepAccounting({
    baseTaskIds: BASE,
    authorshipResults: [
      { taskId: 'planner:b:decompose', result: fullAccounting },
      { taskId: 'planner:b:repair-1', result: { draftVersion: 47, diff: {} } },
    ],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'SWEEP_ACCOUNTING_ABSENT');
  assert.equal(verdict.sourceTaskId, 'planner:b:repair-1');
});

test('evaluateSweepAccounting: partial coverage names the missing IDs', () => {
  const verdict = evaluateSweepAccounting({
    baseTaskIds: BASE,
    authorshipResults: [{
      taskId: 'planner:b:decompose',
      result: { sweepAccounting: ['T-battle - REVISED: done'] },
    }],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'SWEEP_ACCOUNTING_INCOMPLETE');
  assert.deepEqual(verdict.missing, ['T-combat', 'I-root']);
  assert.match(verdict.error, /T-combat/);
});

test('evaluateSweepAccounting: no base tasks - nothing to sweep', () => {
  const verdict = evaluateSweepAccounting({ baseTaskIds: [], authorshipResults: [] });
  assert.equal(verdict.ok, true);
});

test('authorshipResultsForBatch: flow order, authorship purposes only, latest result per task', () => {
  const roleResult = (result) => [{ type: 'ROLE_RESULT', role: 'tech_lead', result }];
  const store = {
    listTasks: () => [
      { id: 'planner:b:repair-2', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 2 }, history: roleResult({ sweepAccounting: [] }) },
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
      { id: 'planner:b:dependencies', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DEPENDENCIES' }, history: roleResult({}) },
      { id: 'planner:b:repair-1', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [] },
      { id: 'planner:other:decompose', projectId: 'p', input: { planningBatchId: 'other', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({}) },
    ], listAllTasks: () => [
      { id: 'planner:b:repair-2', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 2 }, history: roleResult({ sweepAccounting: [] }) },
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
      { id: 'planner:b:dependencies', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DEPENDENCIES' }, history: roleResult({}) },
      { id: 'planner:b:repair-1', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [] },
      { id: 'planner:other:decompose', projectId: 'p', input: { planningBatchId: 'other', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({}) },
    ], listTasksByStates: () => [
      { id: 'planner:b:repair-2', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 2 }, history: roleResult({ sweepAccounting: [] }) },
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
      { id: 'planner:b:dependencies', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DEPENDENCIES' }, history: roleResult({}) },
      { id: 'planner:b:repair-1', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [] },
      { id: 'planner:other:decompose', projectId: 'p', input: { planningBatchId: 'other', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({}) },
    ], listTasksByFlow: () => [
      { id: 'planner:b:repair-2', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 2 }, history: roleResult({ sweepAccounting: [] }) },
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
      { id: 'planner:b:dependencies', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DEPENDENCIES' }, history: roleResult({}) },
      { id: 'planner:b:repair-1', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [] },
      { id: 'planner:other:decompose', projectId: 'p', input: { planningBatchId: 'other', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({}) },
    ], listTasksByScope: () => [
      { id: 'planner:b:repair-2', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 2 }, history: roleResult({ sweepAccounting: [] }) },
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
      { id: 'planner:b:dependencies', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DEPENDENCIES' }, history: roleResult({}) },
      { id: 'planner:b:repair-1', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [] },
      { id: 'planner:other:decompose', projectId: 'p', input: { planningBatchId: 'other', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({}) },
    ],
  };
  const out = authorshipResultsForBatch(store, { projectId: 'p', input: { planningBatchId: 'b' } });
  assert.deepEqual(out.map(item => item.taskId), ['planner:b:decompose', 'planner:b:repair-2']);
});

test('sweepAccountingEntries: accounting nested under validationPlan (batch-55 repair-3 shape)', () => {
  const entries = sweepAccountingEntries({
    draftVersion: 50,
    baseVersion: 32,
    validationPlan: {
      sweepAccounting: ['T-battle - REVISED: reworded', 'T-combat - NON-CONFLICTING.', 'I-root - FLAGGED: see note'],
    },
  });
  assert.equal(entries.length, 3);
  const covered = sweepAccountingCoverage(BASE, entries);
  assert.equal(covered.size, 3);
  assert.deepEqual(sweepAccountingRaw({ validationPlan: { completeSweepAccounting: ['T-battle'] } }), ['T-battle']);
  assert.equal(sweepAccountingRaw({ draftVersion: 1 }), null);
});

test('authorshipResultsForBatch: a gate repair on the validate task counts as the latest authorship result', () => {
  const roleResult = (role, result) => [{ type: 'ROLE_RESULT', role, result }];
  const store = {
    listTasks: () => [
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult('tech_lead', fullAccounting) },
      { id: 'planner:b:repair-3', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 3 }, history: roleResult('tech_lead', { draftVersion: 50 }) },
      { id: 'planner:b:final-validate', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' }, history: [] },
    ], listAllTasks: () => [
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult('tech_lead', fullAccounting) },
      { id: 'planner:b:repair-3', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 3 }, history: roleResult('tech_lead', { draftVersion: 50 }) },
      { id: 'planner:b:final-validate', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' }, history: [] },
    ], listTasksByStates: () => [
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult('tech_lead', fullAccounting) },
      { id: 'planner:b:repair-3', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 3 }, history: roleResult('tech_lead', { draftVersion: 50 }) },
      { id: 'planner:b:final-validate', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' }, history: [] },
    ], listTasksByFlow: () => [
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult('tech_lead', fullAccounting) },
      { id: 'planner:b:repair-3', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 3 }, history: roleResult('tech_lead', { draftVersion: 50 }) },
      { id: 'planner:b:final-validate', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' }, history: [] },
    ], listTasksByScope: () => [
      { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult('tech_lead', fullAccounting) },
      { id: 'planner:b:repair-3', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 3 }, history: roleResult('tech_lead', { draftVersion: 50 }) },
      { id: 'planner:b:final-validate', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' }, history: [] },
    ],
  };
  const validateTask = {
    id: 'planner:b:final-validate',
    projectId: 'p',
    input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' },
    history: [
      { type: 'ROLE_RESULT', role: 'plan_validator', result: { valid: false } },
      { type: 'ROLE_RESULT', role: 'tech_lead', result: fullAccounting },
    ],
  };
  const out = authorshipResultsForBatch(store, validateTask);
  assert.deepEqual(out.map(item => item.taskId), ['planner:b:decompose', 'planner:b:repair-3', 'planner:b:final-validate']);
  const verdict = evaluateSweepAccounting({ baseTaskIds: BASE, authorshipResults: out });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sourceTaskId, 'planner:b:final-validate');
});

test('authorshipResultsForBatch: no self-append for non-validate callers', () => {
  const store = { listTasks: () => [], listAllTasks: () => [], listTasksByStates: () => [], listTasksByFlow: () => [], listTasksByScope: () => []};
  const criticTask = {
    id: 'planner:b:critic-1',
    projectId: 'p',
    input: { planningBatchId: 'b', purpose: 'PLANNER_CRITIC' },
    history: [{ type: 'ROLE_RESULT', role: 'tech_lead', result: fullAccounting }],
  };
  assert.deepEqual(authorshipResultsForBatch(store, criticTask), []);
});

const sweepBatchStore = (repairResult) => {
  const roleResult = (result) => [{ type: 'ROLE_RESULT', role: 'tech_lead', outcome: 'PLANNED', summary: 'did the work', result }];
  return {
    listPlanningRequests: () => [{ batchId: 'b', request: { purpose: 'PM_PLAN_REVISION' } }],
    listTasks: () => [
      { id: 'planner:b:decompose', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ sweepAccounting: ['T-battle - REVISED: reworded', 'T-combat - NON-CONFLICTING.'] }) },
      { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: repairResult ? roleResult(repairResult) : [] },
    ], listAllTasks: () => [
      { id: 'planner:b:decompose', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ sweepAccounting: ['T-battle - REVISED: reworded', 'T-combat - NON-CONFLICTING.'] }) },
      { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: repairResult ? roleResult(repairResult) : [] },
    ], listTasksByStates: () => [
      { id: 'planner:b:decompose', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ sweepAccounting: ['T-battle - REVISED: reworded', 'T-combat - NON-CONFLICTING.'] }) },
      { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: repairResult ? roleResult(repairResult) : [] },
    ], listTasksByFlow: () => [
      { id: 'planner:b:decompose', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ sweepAccounting: ['T-battle - REVISED: reworded', 'T-combat - NON-CONFLICTING.'] }) },
      { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: repairResult ? roleResult(repairResult) : [] },
    ], listTasksByScope: () => [
      { id: 'planner:b:decompose', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ sweepAccounting: ['T-battle - REVISED: reworded', 'T-combat - NON-CONFLICTING.'] }) },
      { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: repairResult ? roleResult(repairResult) : [] },
    ],
  };
};

test('plannerPrompt PLANNER_REPAIR: sweep mandate delivered, previous accounting carried forward', () => {
  const prompt = plannerPrompt({
    store: sweepBatchStore(null),
    project: { id: 'P', spec: null, mode: 'NEW' },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', dependsOn: [], input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1, requests: [] } },
  });
  assert.match(prompt, /SWEEP ACCOUNTING \(MANDATORY FOR THIS BATCH/);
  assert.match(prompt, /previousSweepAccounting/);
  assert.match(prompt, /T-battle - REVISED: reworded/);
});

test('plannerPrompt PLANNER_REPAIR: no sweep mandate for a batch without requirement changes', () => {
  const prompt = plannerPrompt({
    store: { listPlanningRequests: () => [], listTasks: () => [], listAllTasks: () => [], listTasksByStates: () => [], listTasksByFlow: () => [], listTasksByScope: () => []},
    project: { id: 'P', spec: null, mode: 'NEW' },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', dependsOn: [], input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1, requests: [] } },
  });
  assert.doesNotMatch(prompt, /MANDATORY FOR THIS BATCH/);
});

test('criticPrompt: payload carries the batch sweep accounting verbatim and lists repair results', () => {
  const prompt = criticPrompt({
    store: sweepBatchStore({ sweepAccounting: ['T-battle - REVISED: reworded', 'T-combat - NON-CONFLICTING.'] }),
    project: { id: 'P', spec: null },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:critic-2', projectId: 'P', flowId: 'f', dependsOn: [], input: { planningBatchId: 'b', purpose: 'PLANNER_CRITIC', round: 2 } },
  });
  assert.match(prompt, /"sweepAccounting": \{/);
  assert.match(prompt, /"sourceTaskId": "planner:b:repair-1"/);
  assert.match(prompt, /T-battle - REVISED: reworded/);
  assert.match(prompt, /"stage": "repair-1"/);
  assert.match(prompt, /"sweepAccountingEntries": 2/);
});

test('plannerPrompt PLANNER_DECOMPOSE: shared sweep mandate, humanDecisions payload, decision check', () => {
  const store = {
    listPlanningRequests: () => [],
    listTasks: () => [
      { id: 'planner:b:pm-review', projectId: 'P', history: [{ type: 'HUMAN_DECISION', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' }] },
    ], listAllTasks: () => [
      { id: 'planner:b:pm-review', projectId: 'P', history: [{ type: 'HUMAN_DECISION', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' }] },
    ], listTasksByStates: () => [
      { id: 'planner:b:pm-review', projectId: 'P', history: [{ type: 'HUMAN_DECISION', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' }] },
    ], listTasksByFlow: () => [
      { id: 'planner:b:pm-review', projectId: 'P', history: [{ type: 'HUMAN_DECISION', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' }] },
    ], listTasksByScope: () => [
      { id: 'planner:b:pm-review', projectId: 'P', history: [{ type: 'HUMAN_DECISION', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' }] },
    ], listHumanDecisions: () => [
      { taskId: 'planner:b:pm-review', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' },
    ],
  };
  const prompt = plannerPrompt({
    store,
    project: { id: 'P', spec: null, mode: 'NEW' },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:decompose', projectId: 'P', input: { purpose: 'PLANNER_DECOMPOSE', requests: [{ request: { purpose: 'PM_PLAN_REVISION', guidance: 'g', reason: 'r', rejectedDraftVersion: 3 } }] } },
  });
  // The shared mandate (identical text in decompose and repair).
  assert.match(prompt, /at the TOP LEVEL of the result/);
  // Project-wide human decisions reach the Tech Lead, as they reach the PM.
  assert.match(prompt, /"humanDecisions": \[/);
  assert.match(prompt, /Keep the support-pair scope as approved\./);
  // The revision section orders a decision check, and the system prompt
  // states the precedence order.
  assert.match(prompt, /DECISION CHECK/);
  assert.match(prompt, /AUTHORITY AND PRECEDENCE/);
});

test('plannerPrompt PLANNER_REPAIR: repair carries the same shared mandate text', () => {
  const prompt = plannerPrompt({
    store: sweepBatchStore(null),
    project: { id: 'P', spec: null, mode: 'NEW' },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', dependsOn: [], input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1, requests: [] } },
  });
  assert.match(prompt, /at the TOP LEVEL of the result/);
  assert.match(prompt, /SWEEP_ACCOUNTING_INCOMPLETE/);
});
