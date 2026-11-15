import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchRequiresSweepAccounting,
  sweepAccountingEntries,
  sweepAccountingCoverage,
  evaluateSweepAccounting,
  authorshipResultsForBatch,
} from '../src/v2/sweep-accounting.js';

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
    ],
  };
  const out = authorshipResultsForBatch(store, { projectId: 'p', input: { planningBatchId: 'b' } });
  assert.deepEqual(out.map(item => item.taskId), ['planner:b:decompose', 'planner:b:repair-2']);
});
