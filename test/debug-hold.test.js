import test from 'node:test';
import assert from 'node:assert/strict';

import { debugHoldPending } from '../src/v2/planning-helpers.js';

test('debug hold is pending before it ever fired', () => {
  assert.equal(debugHoldPending({ history: [] }), true);
  assert.equal(debugHoldPending({}), true);
  assert.equal(debugHoldPending({ history: [{ type: 'ROLE_RESULT' }] }), true);
});

test('debug hold stays pending until a human decision follows it', () => {
  const held = { history: [{ type: 'DEBUG_HOLD', role: 'pm' }] };
  assert.equal(debugHoldPending(held), true);
  // A decision recorded BEFORE the hold does not release it.
  const decidedEarlier = { history: [{ type: 'HUMAN_DECISION' }, { type: 'DEBUG_HOLD' }] };
  assert.equal(debugHoldPending(decidedEarlier), true);
});

test('a human decision after the hold releases it', () => {
  const released = { history: [{ type: 'DEBUG_HOLD' }, { type: 'HUMAN_DECISION' }] };
  assert.equal(debugHoldPending(released), false);
  // A second hold after the release is pending again.
  const reheld = { history: [{ type: 'DEBUG_HOLD' }, { type: 'HUMAN_DECISION' }, { type: 'DEBUG_HOLD' }] };
  assert.equal(debugHoldPending(reheld), true);
});
