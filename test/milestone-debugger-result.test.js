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
test('debugger runtime failure requires human intervention', () => {
  const next = milestoneResultTransition(task(), { outcome: 'MODEL_CAPABILITY_MISMATCH' });
  assert.equal(next.state, 'NEEDS_HUMAN');
  assert.equal(next.transitionHistory.type, 'SYSTEM_DIAGNOSIS');
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
