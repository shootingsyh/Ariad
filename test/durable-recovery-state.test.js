import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteCheckpointStore } from '../src/sqlite-checkpoint-store.js';
import { SQLiteLeaseStore } from '../src/sqlite-lease-store.js';
import { SQLiteEventJournal } from '../src/sqlite-event-journal.js';

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-'));
  return path.join(dir, name);
}

test('checkpoint survives restart and latest safe checkpoint is selected', () => {
  const file = tempDb('checkpoint.db');
  let store = new SQLiteCheckpointStore(file);
  store.write({ runId:'RUN-1', sequence:1, safeToResume:false, payload:{step:'compile'} });
  store.write({ runId:'RUN-1', sequence:2, safeToResume:true, payload:{step:'tests', remaining:['review']} });
  store.close();

  store = new SQLiteCheckpointStore(file);
  const cp = store.latestSafe('RUN-1');
  assert.equal(cp.sequence, 2);
  assert.equal(cp.safeToResume, true);
  assert.deepEqual(cp.payload.remaining, ['review']);
  store.close();
});

test('unsafe newest checkpoint does not hide older safe checkpoint', () => {
  const file = tempDb('checkpoint-unsafe.db');
  const store = new SQLiteCheckpointStore(file);
  store.write({ runId:'RUN-2', sequence:1, safeToResume:true, payload:{rev:'abc'} });
  store.write({ runId:'RUN-2', sequence:2, safeToResume:false, payload:{rev:'broken'} });
  assert.equal(store.latestSafe('RUN-2').sequence, 1);
  store.close();
});

test('resource lease survives restart and expired lease is reclaimable', () => {
  const file = tempDb('leases.db');
  let now = 1000;
  let store = new SQLiteLeaseStore(file, { now: () => now });
  const lease = store.acquire({ resource:'local_gpu', owner:'RUN-1', ttlMs:100 });
  assert.equal(lease.state, 'ACTIVE');
  assert.equal(store.acquire({ resource:'local_gpu', owner:'RUN-2', ttlMs:100 }), null);
  store.close();

  now = 1200;
  store = new SQLiteLeaseStore(file, { now: () => now });
  const expired = store.reapExpired();
  assert.deepEqual(expired.map(x => x.owner), ['RUN-1']);
  const next = store.acquire({ resource:'local_gpu', owner:'RUN-2', ttlMs:100 });
  assert.equal(next.owner, 'RUN-2');
  store.close();
});

test('lease renew prevents false expiry and release is idempotent', () => {
  const file = tempDb('lease-renew.db');
  let now = 1000;
  const store = new SQLiteLeaseStore(file, { now: () => now });
  const lease = store.acquire({ resource:'bench_scope', owner:'RUN-9', ttlMs:100 });
  now = 1050;
  store.renew(lease.id, 200);
  now = 1150;
  assert.equal(store.reapExpired().length, 0);
  assert.equal(store.release(lease.id).state, 'RELEASED');
  assert.equal(store.release(lease.id).state, 'RELEASED');
  store.close();
});

test('event journal is append-only, ordered, and survives restart', () => {
  const file = tempDb('events.db');
  let journal = new SQLiteEventJournal(file);
  journal.append({ type:'RUN_CREATED', aggregateType:'run', aggregateId:'RUN-1', payload:{role:'developer'} });
  journal.append({ type:'RUN_DISPATCHED', aggregateType:'run', aggregateId:'RUN-1', payload:{runtime:'fake'} });
  journal.close();

  journal = new SQLiteEventJournal(file);
  const events = journal.list({ aggregateType:'run', aggregateId:'RUN-1' });
  assert.deepEqual(events.map(e => e.type), ['RUN_CREATED', 'RUN_DISPATCHED']);
  assert.equal(events[0].seq < events[1].seq, true);
  assert.equal(typeof journal.update, 'undefined');
  assert.equal(typeof journal.delete, 'undefined');
  journal.close();
});

test('event journal supports replay from a sequence boundary', () => {
  const file = tempDb('events-replay.db');
  const journal = new SQLiteEventJournal(file);
  const a = journal.append({ type:'A', aggregateType:'system', aggregateId:'ariad', payload:{} });
  journal.append({ type:'B', aggregateType:'system', aggregateId:'ariad', payload:{} });
  journal.append({ type:'C', aggregateType:'system', aggregateId:'ariad', payload:{} });
  assert.deepEqual(journal.list({ afterSeq:a.seq }).map(e => e.type), ['B','C']);
  journal.close();
});
