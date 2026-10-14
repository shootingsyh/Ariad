import test from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';
import { piRoleResultToolSchema } from '../src/runtime/pi-agent-session-provider.js';

const route = {
  outcome: 'PLANNING_ROUTE', summary: 'Repair interface bindings',
  result: {
    requestType: 'INTERFACE_REPAIR', reason: 'Unbound delivery interfaces',
    scope: { featureRoots: ['srpg'], milestoneRoots: ['V2'] },
    stages: { feature: 'SKIP', milestone: 'SKIP', interface: 'RUN' },
    constraints: { preserveCompletedTasks: true, preserveProductSemantics: true },
  },
};
test('TL can submit strict routing through ariad_role_result', () => {
  const schema = piRoleResultToolSchema('tech_lead');
  assert.equal(Check(schema, route), true);
  assert.equal(Check(schema, { ...route, result: { ...route.result, stages: { feature: 'SKIP' } } }), false);
  assert.equal(Check(schema, { ...route, result: { ...route.result, unexpected: true } }), false);
  assert.equal(Check(schema, { ...route, result: { ...route.result, stages: { feature: 'SKIP', milestone: 'SKIP', interface: 'LATER' } } }), false);
  assert.equal(Check(schema, { outcome: 'PLANNED', summary: 'Legacy planning complete' }), true);
});
