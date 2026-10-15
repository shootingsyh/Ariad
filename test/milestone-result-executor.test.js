import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneResultTransition } from '../src/v2/milestone-result-executor.js';

const task = (stage, extra = {}) => ({ scope: 'delivery', stage, history: [], ...extra });
test('developer passes to test engineer; failure cannot pass', () => {
  assert.equal(milestoneResultTransition(task('developer'), { outcome: 'PASS' }).stage, 'test_engineer');
  assert.equal(milestoneResultTransition(task('developer'), { outcome: 'NOT_PASS' }).stage, 'developer');
  const history = Array.from({ length: 3 }, () => ({ type: 'ROLE_RESULT', role: 'developer', outcome: 'NOT_PASS' }));
  assert.equal(milestoneResultTransition(task('developer', { history }), { outcome: 'NOT_PASS' }).stage, 'project_debugger');
});
test('test engineer requires a nonempty executable plan', () => {
  assert.equal(milestoneResultTransition(task('test_engineer'), { outcome: 'PASS' }).stage, 'project_debugger');
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
