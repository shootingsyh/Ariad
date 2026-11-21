import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneResultTransition } from '../src/v2/milestone-result-executor.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { piRoleResultToolSchema } from '../src/runtime/pi-agent-session-provider.js';

// RETRY_WITH_GUIDANCE routing contract (2026-11-20): the planning ladder's
// debugger transition and prompt have always supported the bounded-repair
// verdict, but the role-result submission schema never offered it, so a
// debugger session could not submit it and fell back to a diagnosis that
// routed nowhere (SRPG batch-167 final-validate). The outcome must be
// submittable and must route everywhere a debugger result is consumed.

test('role-result schema offers RETRY_WITH_GUIDANCE to the project debugger', () => {
  const schema = JSON.stringify(piRoleResultToolSchema('project_debugger'));
  assert.ok(schema.includes('RETRY_WITH_GUIDANCE'), schema.slice(0, 200));
});

const diagTask = (input = {}) => ({ taskKind: 'DIAGNOSTIC', stage: 'project_debugger', input });

test('milestone executor: guided retry repairs a blocked planning task to its home stage', () => {
  const next = milestoneResultTransition(
    diagTask({ blockedTaskId: 'P-blocked', blockedTaskKind: 'PLANNING', blockedTaskPurpose: 'PLANNER_DECOMPOSE' }),
    { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Regenerate the sweep from the current prod baseline.' } },
  );
  assert.equal(next.state, 'DONE');
  assert.equal(next.blockedRoute.taskId, 'P-blocked');
  assert.deepEqual(next.blockedRoute.patch, { stage: 'tech_lead', state: 'READY', execution: null });
  assert.equal(next.blockedRoute.history.diagnosis, 'RETRY_WITH_GUIDANCE');
  assert.equal(next.blockedRoute.history.guidance, 'Regenerate the sweep from the current prod baseline.');
});

test('milestone executor: a guideless RETRY_WITH_GUIDANCE is not a repair', () => {
  const next = milestoneResultTransition(
    diagTask({ blockedTaskId: 'P-blocked', blockedTaskKind: 'PLANNING', blockedTaskPurpose: 'PLANNER_DECOMPOSE' }),
    { outcome: 'RETRY_WITH_GUIDANCE', result: {} },
  );
  assert.equal(next.blockedRoute.patch.state, 'NEEDS_HUMAN');
});

test('milestone executor: guided retry on an escalated task returns to developer', () => {
  const next = milestoneResultTransition(
    { taskKind: 'MILESTONE_TASK', stage: 'project_debugger', input: {} },
    { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Re-run the capture with the fixed harness.' } },
  );
  assert.equal(next.stage, 'developer');
  assert.equal(next.transitionHistory.route, 'developer');
});

test('default roles: guided retry routes the blocked task back to developer with guidance', () => {
  const blockedTask = { id: 'B', projectId: 'P', taskKind: 'FEATURE_TASK', stage: 'tester', state: 'SYSTEM_BLOCKED', version: 7, input: {}, history: [] };
  let routed = null;
  const store = {
    getTask: id => (id === 'B' ? blockedTask : null),
    appendTaskHistory: (id, version, history, patch) => { routed = { id, version, history, patch }; },
  };
  const roles = createDefaultV2Roles({ store, workspace: '/tmp' });
  const diag = { id: 'D', projectId: 'P', taskKind: 'DIAGNOSTIC', stage: 'project_debugger', input: { blockedTaskId: 'B' }, history: [] };
  const next = roles.project_debugger.transition({
    task: diag,
    result: { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Re-run with the fixed harness.' } },
  });
  assert.equal(next.state, 'DONE');
  assert.equal(routed.id, 'B');
  assert.equal(routed.patch.stage, 'developer');
  assert.equal(routed.patch.state, 'READY');
  assert.equal(routed.history.diagnosis, 'RETRY_WITH_GUIDANCE');
  assert.equal(routed.history.guidance, 'Re-run with the fixed harness.');
});

test('default roles: guided retry on the escalated task itself returns it to developer', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const task = { id: 'T', projectId: 'P', taskKind: 'FEATURE_TASK', stage: 'project_debugger', input: {}, history: [] };
  const next = roles.project_debugger.transition({
    task,
    result: { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Fix the harness calibration and re-run.' } },
  });
  assert.equal(next.state, 'READY');
  assert.equal(next.stage, 'developer');
  assert.equal(next.transitionHistory.diagnosis, 'RETRY_WITH_GUIDANCE');
});
