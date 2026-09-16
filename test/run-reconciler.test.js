import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteRunStore } from '../src/sqlite-run-store.js';
import { RuntimeRegistry } from '../src/runtime-registry.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';
import { RunReconciler } from '../src/run-reconciler.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-reconcile-'));
  return { dir, file: path.join(dir, 'state.db') };
}

test('reconciler marks a persisted active run LOST when runtime forgot it after restart', async () => {
  const { dir, file } = fixture();
  try {
    const before = new SQLiteRunStore(file);
    const run = before.create({ taskId: 'T1', role: 'developer', runtimeKey: 'fake', runtimeId: 'fake' });
    before.update(run.id, { state: 'RUNNING', externalId: 'fake:orphaned' });
    before.close();

    const store = new SQLiteRunStore(file);
    const registry = new RuntimeRegistry();
    registry.register('fake', createFakeRuntimeAdapter());
    const observations = [];
    const reconciler = new RunReconciler({ store, registry, emit: event => observations.push(event) });

    await reconciler.reconcile();

    assert.equal(store.get(run.id).state, 'LOST');
    assert.ok(observations.some(event => event.type === 'RUN_LOST' && event.runId === run.id));
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconciler adopts terminal result reported by surviving runtime', async () => {
  const { dir, file } = fixture();
  try {
    const store = new SQLiteRunStore(file);
    const run = store.create({ taskId: 'T2', role: 'tester', runtimeKey: 'survivor', runtimeId: 'survivor' });
    store.update(run.id, { state: 'RUNNING', externalId: 'remote:42' });

    const registry = new RuntimeRegistry();
    registry.register('survivor', {
      id: 'survivor',
      config: {},
      async install() { return { state: 'INSTALLED' }; },
      async probe() { return { health: 'HEALTHY' }; },
      async start() { throw new Error('not used'); },
      async resume() { throw new Error('not used'); },
      async poll() { return { state: 'COMPLETED', outcome: 'PASS', result: { evidence: 'remote' } }; },
      async cancel() { return { state: 'CANCELLED' }; },
    });

    await new RunReconciler({ store, registry }).reconcile();
    const restored = store.get(run.id);
    assert.equal(restored.state, 'COMPLETED');
    assert.equal(restored.result.outcome, 'PASS');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconciler does not poll CREATED runs that were never dispatched', async () => {
  const { dir, file } = fixture();
  try {
    const store = new SQLiteRunStore(file);
    const run = store.create({ taskId: 'T3', role: 'reviewer', runtimeKey: 'fake' });
    const fake = createFakeRuntimeAdapter();
    const registry = new RuntimeRegistry();
    registry.register('fake', fake);
    const observations = [];

    await new RunReconciler({ store, registry, emit: e => observations.push(e) }).reconcile();

    assert.equal(store.get(run.id).state, 'CREATED');
    assert.equal(fake.calls.some(call => call.operation === 'poll'), false);
    assert.ok(observations.some(event => event.type === 'RUN_READY_TO_REDISPATCH'));
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
