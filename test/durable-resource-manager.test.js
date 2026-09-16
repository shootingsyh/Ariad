import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteLeaseStore } from '../src/sqlite-lease-store.js';
import { DurableResourceManager } from '../src/durable-resource-manager.js';

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-resource-'));
  return path.join(dir, name);
}

test('capacity permits configured number of concurrent leases', async () => {
  const store = new SQLiteLeaseStore(tempDb('capacity.db'));
  const manager = new DurableResourceManager({ store, capacities:{ gpu:2 }, defaultTtlMs:1000 });
  const a = await manager.acquire('gpu','RUN-1');
  const b = await manager.acquire('gpu','RUN-2');
  assert.equal(store.listActive('gpu').length, 2);
  let thirdResolved = false;
  const thirdPromise = manager.acquire('gpu','RUN-3').then(x => { thirdResolved = true; return x; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(thirdResolved, false);
  await a.release();
  const c = await thirdPromise;
  assert.equal(c.owner, 'RUN-3');
  await b.release();
  await c.release();
  store.close();
});

test('restart reuses durable occupancy and stale lease can be reclaimed', async () => {
  const file = tempDb('restart.db');
  let now = 1000;
  let store = new SQLiteLeaseStore(file, { now:() => now });
  let manager = new DurableResourceManager({ store, capacities:{ local_gpu:1 }, defaultTtlMs:100 });
  const lease = await manager.acquire('local_gpu','RUN-1');
  assert.equal(lease.owner, 'RUN-1');
  store.close();

  now = 1050;
  store = new SQLiteLeaseStore(file, { now:() => now });
  manager = new DurableResourceManager({ store, capacities:{ local_gpu:1 }, defaultTtlMs:100 });
  assert.equal(manager.tryAcquire('local_gpu','RUN-2'), null);
  now = 1200;
  const expired = manager.reapExpired();
  assert.deepEqual(expired.map(x => x.owner), ['RUN-1']);
  const next = manager.tryAcquire('local_gpu','RUN-2');
  assert.equal(next.owner, 'RUN-2');
  store.close();
});

test('renew heartbeat extends durable lease', async () => {
  const file = tempDb('renew.db');
  let now = 1000;
  const store = new SQLiteLeaseStore(file, { now:() => now });
  const manager = new DurableResourceManager({ store, capacities:{ scope:1 }, defaultTtlMs:100 });
  const lease = await manager.acquire('scope','RUN-1');
  now = 1050;
  lease.renew();
  now = 1120;
  assert.equal(manager.reapExpired().length, 0);
  now = 1160;
  assert.deepEqual(manager.reapExpired().map(x => x.owner), ['RUN-1']);
  store.close();
});

test('unknown resource fails instead of silently inventing capacity', () => {
  const store = new SQLiteLeaseStore(tempDb('unknown.db'));
  const manager = new DurableResourceManager({ store, capacities:{ gpu:1 } });
  assert.throws(() => manager.tryAcquire('mystery','RUN-X'), /Unknown resource/);
  store.close();
});
