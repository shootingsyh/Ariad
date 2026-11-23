import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorshipResultsForBatch,
  derivedSweepAccounting,
} from '../src/v2/sweep-accounting.js';
import { plannerPrompt, criticPrompt, SWEEP_ACCOUNTING_MANDATE } from '../src/v2/role-prompts.js';

const BASE = ['T-battle', 'T-combat', 'I-root'];

test('derivedSweepAccounting: every base task accounted for from the diff itself', () => {
  const diff = {
    tasks: { added: ['T-new'], removed: ['I-root'], changed: ['T-battle'] },
    contracts: { added: [], removed: [], changed: [] },
    detail: {
      tasks: { 'T-battle': { acceptanceCriteria: { from: ['a'], to: ['b'] }, title: { from: 'x', to: 'y' } } },
      contracts: {},
    },
  };
  const entries = derivedSweepAccounting(diff, BASE);
  const byId = Object.fromEntries(entries.map(e => [e.taskId, e]));
  assert.equal(byId['T-battle'].disposition, 'revised');
  assert.match(byId['T-battle'].reason, /acceptanceCriteria/);
  assert.match(byId['T-battle'].reason, /title/);
  assert.equal(byId['T-combat'].disposition, 'non-conflicting');
  assert.equal(byId['I-root'].disposition, 'retired');
  assert.equal(byId['T-new'].disposition, 'created');
  assert.equal(entries.length, 4);
});

test('derivedSweepAccounting: empty diff accounts every base task as non-conflicting', () => {
  const diff = { tasks: { added: [], removed: [], changed: [] }, contracts: { added: [], removed: [], changed: [] }, detail: { tasks: {}, contracts: {} } };
  const entries = derivedSweepAccounting(diff, BASE);
  assert.equal(entries.length, 3);
  assert.ok(entries.every(e => e.disposition === 'non-conflicting'));
  assert.deepEqual(derivedSweepAccounting(diff, []), []);
  assert.deepEqual(derivedSweepAccounting(null, null), []);
});

const roleResult = (result) => [{ type: 'ROLE_RESULT', role: 'tech_lead', result }];
const batchTasks = () => [
  { id: 'planner:b:repair-2', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 2 }, history: roleResult({ draftVersion: 47 }) },
  { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
  { id: 'planner:b:dependencies', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DEPENDENCIES' }, history: roleResult({}) },
  { id: 'planner:b:repair-1', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [] },
  { id: 'planner:other:decompose', projectId: 'p', input: { planningBatchId: 'other', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({}) },
];

test('authorshipResultsForBatch: flow order, authorship purposes only, latest result per task', () => {
  const store = { listAllTasks: () => batchTasks() };
  const out = authorshipResultsForBatch(store, { projectId: 'p', input: { planningBatchId: 'b' } });
  assert.deepEqual(out.map(item => item.taskId), ['planner:b:decompose', 'planner:b:repair-2']);
});

test('authorshipResultsForBatch: a gate repair on the validate task counts as the latest authorship result', () => {
  const store = { listAllTasks: () => [
    { id: 'planner:b:decompose', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
    { id: 'planner:b:repair-3', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 3 }, history: roleResult({ draftVersion: 50 }) },
    { id: 'planner:b:final-validate', projectId: 'p', input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' }, history: [] },
  ] };
  const validateTask = {
    id: 'planner:b:final-validate',
    projectId: 'p',
    input: { planningBatchId: 'b', purpose: 'PLANNER_FINAL_VALIDATE' },
    history: [
      { type: 'ROLE_RESULT', role: 'plan_validator', result: { valid: false } },
      { type: 'ROLE_RESULT', role: 'tech_lead', result: { draftVersion: 51 } },
    ],
  };
  const out = authorshipResultsForBatch(store, validateTask);
  assert.deepEqual(out.map(item => item.taskId), ['planner:b:decompose', 'planner:b:repair-3', 'planner:b:final-validate']);
});

test('authorshipResultsForBatch: no self-append for non-validate callers', () => {
  const store = { listAllTasks: () => [] };
  const criticTask = {
    id: 'planner:b:critic-1',
    projectId: 'p',
    input: { planningBatchId: 'b', purpose: 'PLANNER_CRITIC' },
    history: [{ type: 'ROLE_RESULT', role: 'tech_lead', result: {} }],
  };
  assert.deepEqual(authorshipResultsForBatch(store, criticTask), []);
});

const storeOf = (tasks, requests = []) => ({
  listPlanningRequests: () => requests,
  listTasks: () => tasks,
  listAllTasks: () => tasks,
  listTasksByStates: () => tasks,
  listTasksByFlow: () => tasks,
  listTasksByScope: () => tasks,
  listHumanDecisions: () => [],
});

test('plannerPrompt PLANNER_REPAIR: derived sweep note delivered, no authored accounting carried forward', () => {
  const tasks = [
    { id: 'planner:b:decompose', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: roleResult({ draftVersion: 1 }) },
    { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [] },
  ];
  const prompt = plannerPrompt({
    store: storeOf(tasks, [{ batchId: 'b', request: { purpose: 'PM_PLAN_REVISION' } }]),
    project: { id: 'P', spec: null, mode: 'NEW' },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', dependsOn: [], input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1, requests: [] } },
  });
  assert.match(prompt, /SWEEP ACCOUNTING IS DERIVED, NOT AUTHORED/);
  assert.ok(prompt.includes(SWEEP_ACCOUNTING_MANDATE));
  assert.doesNotMatch(prompt, /previousSweepAccounting/);
  assert.doesNotMatch(prompt, /MANDATORY FOR THIS BATCH/);
  assert.doesNotMatch(prompt, /SWEEP_ACCOUNTING_INCOMPLETE/);
});

test('plannerPrompt PLANNER_DECOMPOSE: shared derived sweep note, humanDecisions payload, decision check', () => {
  const decisionTask = { id: 'planner:b:pm-review', projectId: 'P', history: [{ type: 'HUMAN_DECISION', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' }] };
  const store = storeOf([decisionTask]);
  store.listHumanDecisions = () => [
    { taskId: 'planner:b:pm-review', at: '2026-01-01T00:00:00Z', decision: 'Keep the support-pair scope as approved.' },
  ];
  const prompt = plannerPrompt({
    store,
    project: { id: 'P', spec: null, mode: 'NEW' },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:decompose', projectId: 'P', input: { purpose: 'PLANNER_DECOMPOSE', requests: [{ request: { purpose: 'PM_PLAN_REVISION', guidance: 'g', reason: 'r', rejectedDraftVersion: 3 } }] } },
  });
  // The shared derived-accounting note (identical text in decompose and repair).
  assert.match(prompt, /SWEEP ACCOUNTING IS DERIVED, NOT AUTHORED/);
  assert.doesNotMatch(prompt, /at the TOP LEVEL of the result/);
  // Project-wide human decisions reach the Tech Lead, as they reach the PM.
  assert.match(prompt, /"humanDecisions": \[/);
  assert.match(prompt, /Keep the support-pair scope as approved\./);
  // The revision section orders a decision check, and the system prompt
  // states the precedence order.
  assert.match(prompt, /DECISION CHECK/);
  assert.match(prompt, /AUTHORITY AND PRECEDENCE/);
});

test('criticPrompt: payload carries the derived sweep accounting and plan diff from the validation result', () => {
  const derived = { derived: true, entries: [{ taskId: 'T-battle', disposition: 'revised', reason: 'fields changed: title' }] };
  const diff = {
    draftVersion: 8, baseVersion: 7, diffHash: 'deadbeef',
    tasks: { added: [], removed: [], changed: ['T-battle'] },
    contracts: { added: [], removed: [], changed: [] },
    detail: { tasks: { 'T-battle': { title: { from: 'a', to: 'b' } } }, contracts: {} },
  };
  const tasks = [
    { id: 'planner:b:decompose', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_DECOMPOSE' }, history: [{ type: 'ROLE_RESULT', role: 'tech_lead', outcome: 'PLANNED', summary: 'did the work', result: { draftVersion: 8 } }] },
    { id: 'planner:b:repair-1', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_REPAIR', round: 1 }, history: [{ type: 'ROLE_RESULT', role: 'tech_lead', outcome: 'PLANNED', summary: 'repaired', result: { draftVersion: 8 } }] },
    { id: 'planner:b:validate', projectId: 'P', flowId: 'f', input: { planningBatchId: 'b', purpose: 'PLANNER_VALIDATE' }, history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { valid: true, plan: { tasks: [], sweepAccounting: derived, diff } } }] },
  ];
  const prompt = criticPrompt({
    store: storeOf(tasks, [{ batchId: 'b', request: { purpose: 'PM_PLAN_REVISION' } }]),
    project: { id: 'P', spec: null },
    artifactRoot: '/tmp',
    task: { id: 'planner:b:critic-2', projectId: 'P', flowId: 'f', dependsOn: ['planner:b:validate'], input: { planningBatchId: 'b', purpose: 'PLANNER_CRITIC', round: 2 } },
  });
  assert.match(prompt, /"sweepAccounting": \{/);
  assert.match(prompt, /"derived": true/);
  assert.match(prompt, /"planDiff": \{/);
  assert.match(prompt, /"diffHash": "deadbeef"/);
  assert.match(prompt, /"stage": "repair-1"/);
  assert.doesNotMatch(prompt, /sweepAccountingEntries/);
  assert.match(prompt, /PLAN DIFF AND SWEEP ACCOUNTING/);
});
