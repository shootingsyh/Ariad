import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneResultTransition } from '../src/v2/milestone-result-executor.js';

const task = (stage, extra = {}) => ({ taskKind: 'MILESTONE_TASK', stage, history: [], ...extra });
test('developer passes to test engineer; failure cannot pass', () => {
  assert.equal(milestoneResultTransition(task('developer'), { outcome: 'PASS' }).stage, 'test_engineer');
  assert.equal(milestoneResultTransition(task('developer'), { outcome: 'NOT_PASS' }).stage, 'developer');
  const history = Array.from({ length: 3 }, () => ({ type: 'ROLE_RESULT', role: 'developer', outcome: 'NOT_PASS' }));
  assert.equal(milestoneResultTransition(task('developer', { history }), { outcome: 'NOT_PASS' }).stage, 'project_debugger');
});
test('test engineer requires a nonempty executable plan', () => {
  assert.equal(milestoneResultTransition(task('test_engineer'), { outcome: 'PASS' }).stage, 'test_engineer');
  const result = { outcome: 'PASS', result: { testPlan: { testCases: [{
    entry: 'test/feature.test.js', command: 'node --test test/feature.test.js',
    covers: [], executionScope: [],
  }] } } };
  assert.equal(milestoneResultTransition(task('test_engineer'), result).stage, 'tester');
});
test('tester can request test plan repair without rerunning developer', () => {
  const next = milestoneResultTransition(task('tester'), {
    outcome: 'NOT_PASS', result: { testPlanInvalid: true },
  });
  assert.equal(next.stage, 'test_engineer');
});
test('repeated tester failures escalate to debugger', () => {
  const history = Array.from({ length: 3 }, () => ({
    type: 'ROLE_RESULT', role: 'tester', outcome: 'NOT_PASS',
  }));
  assert.equal(milestoneResultTransition(task('tester', { history }), { outcome: 'NOT_PASS' }).stage, 'project_debugger');
});
test('reviewer can request optional UX review', () => {
  assert.equal(milestoneResultTransition(task('reviewer', { ux: { required: true } }),
    { outcome: 'PASS' }, { uxReviewEnabled: true }).stage, 'ux_reviewer');
});

test('developer unknown or system outcome escalates immediately', () => {
  for (const outcome of ['SYSTEM_RUNTIME_FAILURE', 'MODEL_CAPABILITY_MISMATCH', 'UNKNOWN']) {
    assert.equal(milestoneResultTransition(task('developer'), { outcome }).stage, 'project_debugger');
  }
});

test('test engineer malformed AC mapping retries locally with precise feedback, then escalates after bound', () => {
 const t=task('test_engineer',{acceptanceCriteria:['functional','tested']});
 const r={outcome:'PASS',result:{testPlan:{testCases:[{entry:'test.js',command:'node --test test.js',covers:['functional','AC1'],executionScope:[]}]}}};
 const first=milestoneResultTransition(t,r);
 assert.equal(first.stage,'test_engineer');
 assert.equal(first.transitionHistory.type,'TEST_PLAN_VALIDATION_FAILED');
 assert.ok(first.transitionHistory.errors.some(x=>x.includes('AC2')));
 const second=milestoneResultTransition(task('test_engineer',{acceptanceCriteria:t.acceptanceCriteria,history:[first.transitionHistory]}),r);
 assert.equal(second.stage,'test_engineer');
 const third=milestoneResultTransition(task('test_engineer',{acceptanceCriteria:t.acceptanceCriteria,history:[first.transitionHistory,second.transitionHistory]}),r);
 assert.equal(third.stage,'project_debugger');
 const fixed={outcome:'PASS',result:{testPlan:{testCases:[{entry:'test.js',command:'node --test test.js',covers:['AC1','AC2'],executionScope:[]}]}}};
 assert.equal(milestoneResultTransition(t,fixed).stage,'tester');
});
