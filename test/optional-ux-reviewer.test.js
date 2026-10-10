import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';

const roles = enabled => createDefaultV2Roles({ store: {}, workspace: '/tmp', uxReviewEnabled: enabled });
test('UX reviewer is dormant unless both project binding and task opt-in exist', () => {
  const task = { ux: { required: true } };
  assert.deepEqual(roles(false).reviewer.transition({ task, result: { outcome: 'PASS' } }), { state: 'DONE' });
  assert.deepEqual(roles(true).reviewer.transition({ task: {}, result: { outcome: 'PASS' } }), { state: 'DONE' });
  assert.deepEqual(roles(true).reviewer.transition({ task, result: { outcome: 'PASS' } }), { stage: 'ux_reviewer', state: 'READY' });
  assert.deepEqual(roles(true).ux_reviewer.transition({ task, result: { outcome: 'PASS' } }), { state: 'DONE' });
  assert.deepEqual(roles(true).ux_reviewer.transition({ task, result: { outcome: 'NOT_PASS' } }), { stage: 'developer', state: 'READY' });
});
