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


test('ux rejection returns to the artist first when the task flow includes one (2026-11-14)', () => {
  const artistResult = { type: 'ROLE_RESULT', role: 'artist', outcome: 'PASS' };
  const withArtist = task('ux_reviewer', { history: [artistResult] });
  assert.equal(milestoneResultTransition(withArtist, { outcome: 'NOT_PASS' }).stage, 'artist');
  const artFlag = task('ux_reviewer', { art: { required: true } });
  assert.equal(milestoneResultTransition(artFlag, { outcome: 'NOT_PASS' }).stage, 'artist');
  // No artist in flow: code-only tasks keep the developer route.
  assert.equal(milestoneResultTransition(task('ux_reviewer'), { outcome: 'NOT_PASS' }).stage, 'developer');
  // Escalation bound is unchanged.
  const history = Array.from({ length: 3 }, () => ({ type: 'ROLE_RESULT', role: 'ux_reviewer', outcome: 'NOT_PASS' }));
  assert.equal(milestoneResultTransition(task('ux_reviewer', { history: [artistResult, ...history] }), { outcome: 'NOT_PASS' }).stage, 'project_debugger');
});

test('full-journey cases are rejected for ordinary tasks, allowed at integration/release (2026-11-19)', () => {
  const journey = { outcome: 'PASS', result: { testPlan: { testCases: [{
    id: 'TC-21', entry: 'e2e/whole_product_run.js', command: 'run the packaged app end to end',
    covers: [], executionScope: ['full-journey'],
  }] } } };
  const feature = milestoneResultTransition(task('test_engineer', { taskKind: 'FEATURE_TASK', id: 'T-checkout' }), journey);
  assert.equal(feature.stage, 'test_engineer');
  assert.equal(feature.transitionHistory.type, 'TEST_PLAN_VALIDATION_FAILED');
  assert.ok(feature.transitionHistory.errors.some(x => x.includes('full-journey')));
  const milestone = milestoneResultTransition(task('test_engineer', { id: 'M-checkout' }), journey);
  assert.equal(milestone.stage, 'test_engineer');
  assert.equal(milestoneResultTransition(task('test_engineer', { taskKind: 'INTEGRATION_TASK', id: 'I-root' }), journey).stage, 'tester');
  assert.equal(milestoneResultTransition(task('test_engineer', { id: 'M-app-release' }), journey).stage, 'tester');
});

test('journey classification is declared by tag, never sniffed from entry names (2026-11-19)', () => {
  const scoped = { outcome: 'PASS', result: { testPlan: { testCases: [
    { entry: 'tests/whole_run_journey.gd', command: 'run one scoped chapter entry', covers: [], executionScope: ['headless', 'integration'] },
    { entry: 'src/ui/__tests__/title.test.js', command: 'node --test src/ui/__tests__/title.test.js', covers: [], executionScope: ['leaf', 'headless'] },
  ] } } };
  assert.equal(milestoneResultTransition(task('test_engineer', { taskKind: 'FEATURE_TASK', id: 'T-checkout' }), scoped).stage, 'tester');
});
