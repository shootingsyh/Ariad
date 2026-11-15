import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneResultTransition } from '../src/v2/milestone-result-executor.js';

const task = (input = {}) => ({
  taskKind: 'MILESTONE_TASK', taskKind: 'MILESTONE_TASK',
  stage: 'project_debugger', input,
});
test('debugger implementation repair returns to developer', () => {
  const next = milestoneResultTransition(task(), { outcome: 'WRONG_IMPLEMENTATION_APPROACH' });
  assert.equal(next.stage, 'developer');
  assert.equal(next.transitionHistory.route, 'developer');
});
test('debugger asset diagnosis routes to artist', () => {
  assert.equal(milestoneResultTransition(task(), { outcome: 'ASSET_ISSUE' }).stage, 'artist');
});
test('debugger requirement diagnosis routes to PM', () => {
  assert.equal(milestoneResultTransition(task(), { outcome: 'REQUIREMENT_DECISION_REQUIRED' }).stage, 'pm');
});
test('debugger runtime diagnosis is auto-carried into a developer work order', () => {
  const next = milestoneResultTransition(task(), {
    outcome: 'MODEL_CAPABILITY_MISMATCH', summary: 'Evidence pipeline stale; re-run the render matrix.',
  });
  assert.equal(next.state, 'READY');
  assert.equal(next.stage, 'developer');
  assert.equal(next.transitionHistory.type, 'DEBUGGER_ROUTE');
  assert.equal(next.transitionHistory.route, 'developer');
  assert.equal(next.transitionHistory.autoCarried, true);
  assert.equal(next.transitionHistory.guidance, 'Evidence pipeline stale; re-run the render matrix.');
});
test('debugger runtime diagnosis parks when the debugger marks it operator-required', () => {
  const next = milestoneResultTransition(task(), {
    outcome: 'SYSTEM_RUNTIME_FAILURE',
    summary: 'Host tool permission is broken.',
    result: { operatorRequired: true },
  });
  assert.equal(next.state, 'NEEDS_HUMAN');
  assert.equal(next.transitionHistory.type, 'SYSTEM_DIAGNOSIS');
});
test('debugger runtime diagnosis parks after the auto-carry limit, human decision resets it', () => {
  const carried = { type: 'DEBUGGER_ROUTE', role: 'project_debugger', route: 'developer', autoCarried: true };
  const exhausted = { ...task(), history: [carried, carried] };
  const next = milestoneResultTransition(exhausted, { outcome: 'SYSTEM_RUNTIME_FAILURE', summary: 'Still broken.' });
  assert.equal(next.state, 'NEEDS_HUMAN');
  assert.equal(next.transitionHistory.type, 'SYSTEM_DIAGNOSIS');
  const decided = { ...task(), history: [carried, carried, { type: 'HUMAN_DECISION', decision: 'proceed' }] };
  const afterDecision = milestoneResultTransition(decided, { outcome: 'SYSTEM_RUNTIME_FAILURE', summary: 'Still broken.' });
  assert.equal(afterDecision.stage, 'developer');
  assert.equal(afterDecision.transitionHistory.autoCarried, true);
});
test('unrecognized debugger diagnosis routes to PM', () => {
  const next = milestoneResultTransition(task(), { outcome: 'SOMETHING_NEW' });
  assert.equal(next.stage, 'pm');
  assert.equal(next.transitionHistory.diagnosis, 'SOMETHING_NEW');
});
test('debugger routing targets have valid executor bindings', async () => {
  const { roleExecutorBinding } = await import('../src/v2/role-executor-binding.js');
  assert.equal(roleExecutorBinding({ taskKind: 'MILESTONE_TASK', stage: 'artist' }).state, 'ARTIST');
  assert.equal(roleExecutorBinding({ taskKind: 'MILESTONE_TASK', stage: 'pm' }).state, 'PM');
});
test('side-effectful debugger cases stay on existing atomic routing path', () => {
  const routed = milestoneResultTransition(task({ blockedTaskId: 'T' }), { outcome: 'ASSET_ISSUE' });
  assert.equal(routed.state, 'DONE');
  assert.equal(routed.blockedRoute.taskId, 'T');
  assert.equal(routed.blockedRoute.patch.stage, 'artist');
  const replan = milestoneResultTransition(task(), { outcome: 'TASK_TOO_LARGE' });
  assert.equal(replan.state, 'WAITING_REPLAN');
  assert.equal(replan.planningRequest.request.purpose, 'REPLAN_TASK');
});

const diagTask = (input = {}) => ({
  taskKind: 'DIAGNOSTIC', stage: 'project_debugger', input,
});
const planningDiag = (purpose) => diagTask({
  blockedTaskId: 'P-blocked', blockedTaskKind: 'PLANNING', blockedTaskPurpose: purpose,
});
test('debugger runtime diagnosis returns a blocked planning gate to its validator stage', () => {
  const next = milestoneResultTransition(planningDiag('PLANNER_FINAL_VALIDATE'), {
    outcome: 'SYSTEM_RUNTIME_FAILURE', summary: 'Validator misread the accounting; fixed in the new build.',
  });
  assert.equal(next.state, 'DONE');
  assert.equal(next.blockedRoute.taskId, 'P-blocked');
  assert.deepEqual(next.blockedRoute.patch, { stage: 'plan_validator', state: 'READY', execution: null });
  assert.equal(next.blockedRoute.history.route, 'plan_validator');
  assert.equal(next.blockedRoute.history.autoCarried, true);
});
test('debugger diagnosis returns blocked planning tasks to their home stage', () => {
  const cases = [
    ['PLANNER_DECOMPOSE', 'tech_lead'],
    ['PLANNER_REPAIR', 'tech_lead'],
    ['PLANNER_VALIDATE', 'plan_validator'],
    ['PLANNER_CRITIC', 'tech_lead_critic'],
    ['PLANNER_PM_REVIEW', 'pm'],
  ];
  for (const [purpose, stage] of cases) {
    const next = milestoneResultTransition(planningDiag(purpose), { outcome: 'WRONG_IMPLEMENTATION_APPROACH' });
    assert.equal(next.blockedRoute.patch.stage, stage, purpose);
    assert.equal(next.blockedRoute.patch.state, 'READY', purpose);
  }
});
test('debugger decision verdict parks a blocked planning task at its human gate', () => {
  const next = milestoneResultTransition(planningDiag('PLANNER_DECOMPOSE'), {
    outcome: 'REQUIREMENT_DECISION_REQUIRED', summary: 'Scope question for the owner.',
    result: { questions: ['Widen the scope?'] },
  });
  assert.equal(next.state, 'DONE');
  assert.equal(next.blockedRoute.patch.state, 'NEEDS_HUMAN');
  assert.equal(next.blockedRoute.patch.stage, undefined);
  assert.equal(next.blockedRoute.history.route, 'pm');
  assert.equal(next.blockedRoute.history.summary, 'Scope question for the owner.');
  assert.deepEqual(next.blockedRoute.history.questions, ['Widen the scope?']);
});
test('debugger too-large verdict sends a blocked planning task back to its tech lead without a replan request', () => {
  const next = milestoneResultTransition(planningDiag('PLANNER_DECOMPOSE'), { outcome: 'TASK_TOO_LARGE' });
  assert.equal(next.state, 'DONE');
  assert.deepEqual(next.blockedRoute.patch, { stage: 'tech_lead', state: 'READY', execution: null });
  assert.equal(next.planningRequest, undefined);
});
