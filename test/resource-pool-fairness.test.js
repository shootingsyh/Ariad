import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourcePool, ScopedResourcePool } from '../src/v2/resource-pool.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a waiting scope wins the freed slot over the previous holder re-claiming', () => {
  const pool = new ResourcePool({ 'local-llm': 1 });
  const srpg = new ScopedResourcePool(pool, 'srpg');
  const probe = new ScopedResourcePool(pool, 'iterprobe');

  // SRPG holds the only slot; iterprobe tries and registers as waiter.
  assert.equal(srpg.claim(['local-llm'], 'task-a'), true);
  assert.equal(probe.claim(['local-llm'], 'task-1'), false);

  // SRPG's session ends and its next task immediately tries to re-claim
  // inside the same tick (the starvation pattern): it must yield to the
  // waiting scope instead of taking the slot again.
  srpg.release('task-a');
  assert.equal(srpg.claim(['local-llm'], 'task-b'), false);

  // The waiter now claims; afterwards the roles reverse symmetrically.
  assert.equal(probe.claim(['local-llm'], 'task-1'), true);
  probe.release('task-1');
  assert.equal(probe.claim(['local-llm'], 'task-2'), false);
  assert.equal(srpg.claim(['local-llm'], 'task-b'), true);
});

test('a stale waiter that stopped retrying does not block the pool', async () => {
  const pool = new ResourcePool({ 'local-llm': 1 });
  pool.waitFreshMs = 40;
  const a = new ScopedResourcePool(pool, 'aaa');
  const b = new ScopedResourcePool(pool, 'bbb');
  assert.equal(a.claim(['local-llm'], 't1'), true);
  assert.equal(b.claim(['local-llm'], 't1'), false); // bbb waits, then goes away
  a.release('t1');
  await sleep(60); // bbb's wait goes stale
  assert.equal(a.claim(['local-llm'], 't2'), true);
});

test('uncontended claims and empty requirements behave as before', () => {
  const pool = new ResourcePool({ 'local-llm': 1 });
  assert.equal(pool.claim([], 'anyone'), true);
  assert.equal(pool.claim(['local-llm'], 'solo:task'), true);
  assert.equal(pool.claim(['local-llm'], 'solo:task'), true); // idempotent re-claim
  pool.release('solo:task');
  assert.equal(pool.claim(['local-llm'], 'other:task'), true);
});
