import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteLeaseStore } from '../src/sqlite-lease-store.js';
import { DurableResourceManager } from '../src/durable-resource-manager.js';
import { Scheduler } from '../src/scheduler.js';

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-scheduler-'));
  return path.join(dir, name);
}

function makeResources(capacities) {
  const store = new SQLiteLeaseStore(tempDb('leases.db'));
  return { store, manager:new DurableResourceManager({ store, capacities, defaultTtlMs:1000 }) };
}

test('scheduler blocks unhealthy runtime without acquiring resources', async () => {
  const { store, manager } = makeResources({ gpu:1 });
  const scheduler = new Scheduler({
    resourceManager:manager,
    isRuntimeHealthy:key => key !== 'bad',
    dispatch:async () => { throw new Error('must not dispatch'); },
  });
  const result = await scheduler.tryDispatch({ taskId:'T1', role:'developer', runtimeKey:'bad', resources:['gpu'] });
  assert.deepEqual(result, { status:'BLOCKED_RUNTIME', runtimeKey:'bad' });
  assert.equal(store.listActive().length, 0);
  store.close();
});

test('scheduler returns WAITING_RESOURCE and does not create execution when resource is occupied', async () => {
  const { store, manager } = makeResources({ gpu:1 });
  const held = await manager.acquire('gpu','OTHER');
  let dispatched = false;
  const scheduler = new Scheduler({
    resourceManager:manager,
    isRuntimeHealthy:() => true,
    dispatch:async () => { dispatched = true; },
  });
  const result = await scheduler.tryDispatch({ taskId:'T2', role:'developer', runtimeKey:'local', resources:['gpu'] });
  assert.equal(result.status, 'WAITING_RESOURCE');
  assert.equal(result.resource, 'gpu');
  assert.equal(dispatched, false);
  await held.release();
  store.close();
});

test('scheduler acquires all resources, dispatches once, and releases leases on success', async () => {
  const { store, manager } = makeResources({ gpu:1, scope:1 });
  const calls=[];
  const scheduler = new Scheduler({
    resourceManager:manager,
    isRuntimeHealthy:() => true,
    dispatch:async work => { calls.push(work); return { executionStatus:'COMPLETED', runId:'RUN-1' }; },
  });
  const work={ taskId:'T3', role:'tester', runtimeKey:'local', resources:['gpu','scope'] };
  const result=await scheduler.tryDispatch(work);
  assert.equal(result.status,'DISPATCHED');
  assert.equal(result.result.runId,'RUN-1');
  assert.equal(calls.length,1);
  assert.equal(store.listActive().length,0);
  store.close();
});

test('scheduler releases already-acquired leases when a later resource is unavailable', async () => {
  const { store, manager } = makeResources({ gpu:1, scope:1 });
  const held = await manager.acquire('scope','OTHER');
  const scheduler = new Scheduler({ resourceManager:manager, isRuntimeHealthy:() => true, dispatch:async()=>({}) });
  const result = await scheduler.tryDispatch({ taskId:'T4', role:'tester', runtimeKey:'local', resources:['gpu','scope'] });
  assert.equal(result.status,'WAITING_RESOURCE');
  assert.deepEqual(store.listActive().map(x=>x.owner), ['OTHER']);
  await held.release();
  store.close();
});

test('scheduler releases leases when dispatch throws', async () => {
  const { store, manager } = makeResources({ gpu:1 });
  const scheduler = new Scheduler({
    resourceManager:manager,
    isRuntimeHealthy:() => true,
    dispatch:async () => { throw new Error('executor crashed'); },
  });
  await assert.rejects(() => scheduler.tryDispatch({ taskId:'T5', role:'developer', runtimeKey:'local', resources:['gpu'] }), /executor crashed/);
  assert.equal(store.listActive().length,0);
  store.close();
});
