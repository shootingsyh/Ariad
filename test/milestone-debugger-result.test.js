import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneResultTransition } from '../src/v2/milestone-result-executor.js';

const task = (input = {}) => ({
  taskKind: 'MILESTONE_TASK', scope: 'delivery',
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
test('side-effectful debugger cases stay on existing atomic routing path', () => {
  assert.equal(milestoneResultTransition(task({ blockedTaskId: 'T' }), { outcome: 'ASSET_ISSUE' }), null);
  assert.equal(milestoneResultTransition(task(), { outcome: 'TASK_TOO_LARGE' }), null);
});
