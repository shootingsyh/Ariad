import test from 'node:test';
import assert from 'node:assert/strict';
import { TransitionEngine } from '../src/transition-engine.js';

function state(overrides = {}) {
  return {
    taskId: 'F1',
    stage: 'developer',
    devCycle: 1,
    strategyEpoch: 1,
    status: 'RUNNING',
    version: 1,
    ...overrides,
  };
}

test('developer completion advances to tester', () => {
  const engine = new TransitionEngine();
  assert.deepEqual(engine.next(state(), 'developer', { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTED' }), { patch: { stage: 'tester', status: 'RUNNING' }, effect: null });
});

test('tester NOT_PASS increments dev cycle until max', () => {
  const engine = new TransitionEngine();
  assert.deepEqual(engine.next(state({ stage: 'tester', devCycle: 1 }), 'tester', { executionStatus: 'COMPLETED', outcome: 'NOT_PASS' }), { patch: { stage: 'developer', devCycle: 2, status: 'RUNNING' }, effect: null });
});

test('third NOT_PASS escalates to project debugger without incrementing beyond max', () => {
  const engine = new TransitionEngine();
  assert.deepEqual(engine.next(state({ stage: 'reviewer', devCycle: 3 }), 'reviewer', { executionStatus: 'COMPLETED', outcome: 'NOT_PASS' }), { patch: { stage: 'project_debugger', status: 'RUNNING' }, effect: { type: 'ESCALATED_TO_PROJECT_DEBUGGER' } });
});

test('execution failure pauses system and never mutates dev cycle', () => {
  const engine = new TransitionEngine();
  const current = state({ stage: 'tester', devCycle: 2 });
  const transition = engine.next(current, 'tester', { executionStatus: 'FAILED', failure: 'runtime died', runId: 'RUN-7' });
  assert.deepEqual(transition.patch, { status: 'PAUSED_SYSTEM' });
  assert.equal(transition.effect.type, 'RELIABILITY_REQUIRED');
  assert.equal(transition.effect.runId, 'RUN-7');
  assert.equal(Object.hasOwn(transition.patch, 'devCycle'), false);
});

test('reviewer PASS requires source control finalization before success', () => {
  const engine = new TransitionEngine();
  const transition = engine.next(state({ stage: 'reviewer' }), 'reviewer', { executionStatus: 'COMPLETED', outcome: 'PASS' });
  assert.deepEqual(transition, { patch: { status: 'AWAITING_SOURCE_CONTROL' }, effect: { type: 'FINALIZE_SOURCE_CONTROL' } });
  assert.deepEqual(engine.completeSourceControl({ ...state({ stage: 'reviewer' }), status: 'AWAITING_SOURCE_CONTROL' }, { ok: true }), { patch: { status: 'SUCCEEDED' }, effect: null });
});

test('wrong implementation approach starts a new strategy epoch and resets cycle', () => {
  const engine = new TransitionEngine();
  assert.deepEqual(engine.next(state({ stage: 'project_debugger', devCycle: 3, strategyEpoch: 1 }), 'project_debugger', {
    executionStatus: 'COMPLETED', outcome: 'WRONG_IMPLEMENTATION_APPROACH', guidance: 'replace polling with events',
  }), {
    patch: { stage: 'developer', strategyEpoch: 2, devCycle: 1, status: 'RUNNING' },
    effect: { type: 'APPLY_STRATEGY_GUIDANCE', guidance: 'replace polling with events' },
  });
});

test('strategy epoch exhaustion needs human instead of looping forever', () => {
  const engine = new TransitionEngine({ maxStrategyEpochs: 3 });
  assert.deepEqual(engine.next(state({ stage: 'project_debugger', devCycle: 3, strategyEpoch: 3 }), 'project_debugger', { executionStatus: 'COMPLETED', outcome: 'WRONG_IMPLEMENTATION_APPROACH' }), { patch: { status: 'NEEDS_HUMAN' }, effect: { type: 'STRATEGY_EPOCHS_EXHAUSTED' } });
});

test('human decision resumes the same durable stage and records decision context', () => {
  const engine = new TransitionEngine();
  const decision = { eventId: 'e1', decision: 'Keep the public API stable and change internals only.' };
  const transition = engine.resumeHumanDecision(state({
    stage: 'project_debugger',
    devCycle: 3,
    status: 'NEEDS_HUMAN',
    context: { reason: 'requirements conflict' },
  }), decision);
  assert.equal(transition.patch.status, 'RUNNING');
  assert.equal(Object.hasOwn(transition.patch, 'stage'), false, 'resume must not invent a new role');
  assert.deepEqual(transition.patch.context.humanDecision, decision);
  assert.deepEqual(transition.patch.context.humanDecisionHistory, [decision]);
  assert.equal(transition.patch.context.reason, 'requirements conflict');
});

test('project debugger routes oversized task to Tech Lead', () => {
  const engine = new TransitionEngine();
  assert.deepEqual(engine.next(state({ stage: 'project_debugger', devCycle: 3 }), 'project_debugger', { executionStatus: 'COMPLETED', outcome: 'TASK_TOO_LARGE' }), {
    patch: { stage: 'tech_lead', status: 'RUNNING' },
    effect: { type: 'TECH_LEAD_REPLAN_REQUIRED', diagnosis: 'TASK_TOO_LARGE' },
  });
});

test('project debugger routes contradictory requirement to human-facing PM decision path', () => {
  const engine = new TransitionEngine();
  assert.deepEqual(engine.next(state({ stage: 'project_debugger', devCycle: 3 }), 'project_debugger', { executionStatus: 'COMPLETED', outcome: 'TASK_CONTRADICTORY' }), {
    patch: { status: 'NEEDS_HUMAN' },
    effect: { type: 'PRODUCT_REQUIREMENT_CONFLICT', diagnosis: 'TASK_CONTRADICTORY' },
  });
});

test('Tech Lead replanned result stops at WAITING_REPLAN for graph mutation', () => {
  const engine = new TransitionEngine();
  assert.deepEqual(engine.next(state({ stage: 'tech_lead' }), 'tech_lead', { executionStatus: 'COMPLETED', outcome: 'REPLANNED' }), {
    patch: { status: 'WAITING_REPLAN' }, effect: { type: 'WORKFLOW_GRAPH_MUTATION_REQUIRED' },
  });
});

test('role must match durable stage', () => {
  const engine = new TransitionEngine();
  assert.throws(() => engine.next(state({ stage: 'tester' }), 'reviewer', { executionStatus: 'COMPLETED', outcome: 'PASS' }), /does not match workflow stage/);
});
