import test from 'node:test';
import assert from 'node:assert/strict';
import { subPlanResultTransition } from '../src/v2/sub-plan-result-executor.js';

const task = (stage, extra = {}) => ({
  taskKind: 'NODE_PLANNING', scope: 'control', stage,
  input: { stages: ['tech_lead', 'plan_validator'], ...extra },
});
test('validator completion without critic finishes via DSL signal', () => {
  assert.equal(subPlanResultTransition(task('plan_validator'), { outcome: 'PASS' }).state, 'DONE');
});
test('validator failure retries TL then escalates to debugger', () => {
  const retry = subPlanResultTransition(task('plan_validator'), { outcome: 'NOT_PASS' });
  assert.equal(retry.stage, 'tech_lead');
  assert.equal(retry.input.workflowRetries, 1);
  const escalation = subPlanResultTransition(task('plan_validator', { workflowRetries: 2 }), { outcome: 'NOT_PASS' });
  assert.equal(escalation.stage, 'project_debugger');
});
test('critic is mandatory when present', () => {
  const next = subPlanResultTransition(task('plan_validator', { stages: ['tech_lead', 'plan_validator', 'tech_lead_critic'] }), { outcome: 'PASS' });
  assert.equal(next.stage, 'tech_lead_critic');
});
test('debugger guidance is bounded and cannot override rejection', () => {
  const repaired = subPlanResultTransition(task('project_debugger', { workflowRetries: 2 }), {
    outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'fix evidence' },
  });
  assert.equal(repaired.stage, 'tech_lead');
  assert.equal(repaired.input.debuggerRecoveryCount, 1);
  assert.equal(subPlanResultTransition(task('project_debugger', { debuggerRecoveryCount: 1 }), {
    outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'again' },
  }).state, 'NEEDS_HUMAN');
});
