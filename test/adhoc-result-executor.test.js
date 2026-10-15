import test from 'node:test';
import assert from 'node:assert/strict';
import { adhocResultTransition } from '../src/v2/adhoc-result-executor.js';

const task = { scope: 'control', taskKind: 'ADHOC_ANALYSIS', stage: 'tech_lead' };
test('ad-hoc success completes', () => {
  assert.equal(adhocResultTransition(task, { outcome: 'PLANNED' }).state, 'DONE');
});
test('ad-hoc rejection requires human intervention', () => {
  const next = adhocResultTransition(task, { outcome: 'ERROR' });
  assert.equal(next.state, 'NEEDS_HUMAN');
  assert.equal(next.transitionHistory.type, 'ADHOC_ANALYSIS_REJECTED');
});
test('other task kinds are not handled by ad-hoc executor', () => {
  assert.equal(adhocResultTransition({ scope: 'delivery', stage: 'developer' }, { outcome: 'PASS' }), null);
});
