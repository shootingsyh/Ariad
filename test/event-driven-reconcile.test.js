import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReconcileTrigger } from '../src/v2/reconcile-trigger.js';
import { SQLiteReconcileSignal } from '../src/v2/sqlite-reconcile-signal.js';
import { FileReconcileWake } from '../src/v2/file-reconcile-wake.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';

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

test('wake from request context reconciles in the trigger background context', async () => {
  const requestContext = new AsyncLocalStorage();
  const seen = [];
  const trigger = new ReconcileTrigger({
    readGeneration: () => 0,
    reconcile: async () => { seen.push(requestContext.getStore() ?? null); },
    safetyIntervalMs: 60_000,
  });
  trigger.start();
  await flush();
  seen.length = 0;

  requestContext.run({ modelOverride: 'caller-owned' }, () => trigger.wake('tool-request'));
  await flush();

  assert.deepEqual(seen, [null]);
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

test('durable v2 state mutations automatically advance reconcile generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-reconcile-store-'));
  const file = path.join(dir, 'state.db');
  let store;
  let signal;
  try {
    // The production runtime opens/migrates the v2 store before attaching the
    // reconcile signal, so the signal can install triggers on durable tables.
    store = new SQLiteV2Store(file);
    signal = new SQLiteReconcileSignal(file);
    const initial = signal.read();

    store.createProject({ id: 'p1', spec: 'test', workspace: dir });
    const afterCreate = signal.read();
    assert.ok(afterCreate > initial);

    const project = store.getProject('p1');
    store.updateProject('p1', project.version, { deliveryEnabled: true });
    const afterUpdate = signal.read();
    assert.ok(afterUpdate > afterCreate);

    store.enqueuePlanningRequest({
      id: 'plan-1',
      projectId: 'p1',
      request: { purpose: 'INITIAL_PLAN' },
    });
    assert.ok(signal.read() > afterUpdate);
  } finally {
    signal?.close();
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('cross-process wake file notifies the sleeping scheduler owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-wake-file-'));
  const wakeFile = join(root, 'reconcile.wake');
  const ownerSignal = new FileReconcileWake(wakeFile);
  const externalSignal = new FileReconcileWake(wakeFile);
  let wakes = 0;
  ownerSignal.start(() => { wakes += 1; });

  externalSignal.emit('iterate');

  await waitFor(() => wakes > 0);
  ownerSignal.stop();
  rmSync(root, { recursive: true, force: true });
});
