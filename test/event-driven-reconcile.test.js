import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReconcileTrigger } from '../src/v2/reconcile-trigger.js';
import { SQLiteReconcileSignal } from '../src/v2/sqlite-reconcile-signal.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test('coalesces concurrent wakes into a single reconcile when durable generation is unchanged', async () => {
  let generation = 0;
  let calls = 0;
  const trigger = new ReconcileTrigger({
    readGeneration: () => generation,
    reconcile: async () => { calls += 1; },
    safetyIntervalMs: 60_000,
  });
  trigger.start();
  trigger.wake();
  trigger.wake();
  trigger.wake();
  await flush();
  assert.equal(calls, 1);
  trigger.stop();
});

test('reruns once when generation changes during an active reconcile', async () => {
  let generation = 0;
  let calls = 0;
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const trigger = new ReconcileTrigger({
    readGeneration: () => generation,
    reconcile: async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
    },
    safetyIntervalMs: 60_000,
  });
  trigger.start();
  await new Promise(resolve => setTimeout(resolve, 5));
  generation += 1;
  trigger.wake('role-result');
  trigger.wake('role-result-duplicate');
  releaseFirst();
  await flush();
  assert.equal(calls, 2);
  trigger.stop();
});

test('wake at drain boundary is not lost', async () => {
  let generation = 0;
  let calls = 0;
  const trigger = new ReconcileTrigger({
    readGeneration: () => generation,
    reconcile: async () => {
      calls += 1;
      if (calls === 1) queueMicrotask(() => {
        generation += 1;
        trigger.wake('boundary');
      });
    },
    safetyIntervalMs: 60_000,
  });
  trigger.start();
  await flush();
  assert.equal(calls, 2);
  trigger.stop();
});

test('sqlite reconcile generation survives reopen and increments atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-reconcile-'));
  const file = path.join(dir, 'state.db');
  try {
    let signal = new SQLiteReconcileSignal(file);
    assert.equal(signal.read(), 0);
    assert.equal(signal.bump(), 1);
    assert.equal(signal.bump(), 2);
    signal.close();
    signal = new SQLiteReconcileSignal(file);
    assert.equal(signal.read(), 2);
    assert.equal(signal.bump(), 3);
    signal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
