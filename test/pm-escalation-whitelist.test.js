import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';

// Escalation whitelist: the PM may summon a human ONLY over the
// requirements themselves, and only with concrete questions attached.
function pmTransition(result) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-pm-esc-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: false, spec: 'Build task tracker' });
    const roles = createDefaultV2Roles({ store, workspace: dir, artifactRoot: join(dir, '.ariad', 'artifacts'), providerId: 'fake', codeProviderId: 'ariad-code' });
    const task = { id: 'pm-approval', projectId: 'P', taskKind: 'PLANNING', stage: 'pm', flowId: 'planner:P:1',
      input: { purpose: 'PLANNER_PM_REVIEW' }, history: [] };
    return roles.pm.transition({ task, result });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('PM NEEDS_HUMAN with concrete requirements questions is honored', () => {
  const r = pmTransition({ outcome: 'NEEDS_HUMAN', summary: 'Goal is ambiguous', result: { reason: 'Two readings of the goal', questions: ['Should the tracker sync across devices, or is local-only acceptable?'] } });
  assert.equal(r.state, 'NEEDS_HUMAN');
  assert.equal(r.transitionHistory.type, 'PM_HUMAN_DECISION');
  assert.deepEqual(r.transitionHistory.questions, ['Should the tracker sync across devices, or is local-only acceptable?']);
});

test('PM NEEDS_HUMAN without questions is NOT a human escalation', () => {
  const r = pmTransition({ outcome: 'NEEDS_HUMAN', summary: 'Not sure about the plan', result: { reason: 'Plan feels off' } });
  assert.notEqual(r.state, 'NEEDS_HUMAN');
  assert.notEqual(r.transitionHistory?.type, 'PM_HUMAN_DECISION');
});

test('PM NEEDS_HUMAN with only blank questions is NOT a human escalation', () => {
  const r = pmTransition({ outcome: 'NEEDS_HUMAN', result: { questions: ['   ', ''] } });
  assert.notEqual(r.state, 'NEEDS_HUMAN');
  assert.notEqual(r.transitionHistory?.type, 'PM_HUMAN_DECISION');
});
