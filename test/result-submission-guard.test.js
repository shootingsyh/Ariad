import test from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';

import {
  createResultSubmissionGuard,
  piDeclaredRoleResultToolSchema,
  piRoleResultToolSchema,
  MAX_CONSECUTIVE_INVALID_RESULT_SUBMISSIONS,
} from '../src/runtime/pi-agent-session-provider.js';

// The 2026-11-01 SRPG incident payload: a tester result carrying the seal
// slots but no criteria. It validated under the old declared schema (where
// criteria was Optional) and was rejected by the strict schema, ~1000
// times in a row, because the model could not see the contract it was
// actually judged by.
const incidentPayload = {
  outcome: 'NOT_PASS',
  summary: 'audio tests executed',
  result: {
    interfaceRealizations: [],
    interfaceVerifications: [],
    interfaceReviews: [],
    discoveredIssues: [{ title: 'case failed', description: 'one playback case failed' }],
  },
};

const validTesterPayload = {
  outcome: 'NOT_PASS',
  summary: 'audio tests executed',
  result: {
    criteria: [{
      criterionId: 'AC1',
      status: 'FAILED',
      evidenceType: 'runtime',
      evidence: ['tc_battle_sfx.log'],
      reason: 'one playback case failed',
    }],
    interfaceVerifications: [],
  },
};

test('the incident payload is invalid under the schema the model is shown', () => {
  assert.equal(Check(piDeclaredRoleResultToolSchema('tester'), incidentPayload), false);
  assert.equal(Check(piRoleResultToolSchema('tester'), incidentPayload), false);
  assert.equal(Check(piDeclaredRoleResultToolSchema('tester'), validTesterPayload), true);
});

test('guard trips after the configured number of consecutive invalid submissions', () => {
  const guard = createResultSubmissionGuard('tester', 3);
  const first = guard.validate(incidentPayload);
  assert.equal(first.ok, false);
  assert.equal(first.tripped, false);
  assert.match(first.detail, /criteria/);
  assert.equal(guard.validate(incidentPayload).tripped, false);
  const third = guard.validate(incidentPayload);
  assert.equal(third.ok, false);
  assert.equal(third.tripped, true);
  assert.equal(third.invalidCount, 3);
});

test('a valid submission resets the consecutive-invalid count', () => {
  const guard = createResultSubmissionGuard('tester', 3);
  guard.validate(incidentPayload);
  guard.validate(incidentPayload);
  assert.equal(guard.validate(validTesterPayload).ok, true);
  const after = guard.validate(incidentPayload);
  assert.equal(after.invalidCount, 1);
  assert.equal(after.tripped, false);
});

test('the default breaker limit is a small finite number', () => {
  assert.ok(Number.isInteger(MAX_CONSECUTIVE_INVALID_RESULT_SUBMISSIONS));
  assert.ok(MAX_CONSECUTIVE_INVALID_RESULT_SUBMISSIONS >= 2);
  assert.ok(MAX_CONSECUTIVE_INVALID_RESULT_SUBMISSIONS <= 20);
});
