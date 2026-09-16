import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteRunStore } from '../src/sqlite-run-store.js';
import { RuntimeRegistry } from '../src/runtime-registry.js';
import { RuntimeExecutor } from '../src/runtime-executor.js';
import { RunReconciler } from '../src/run-reconciler.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-hardening-'));
  return { dir, file: path.join(dir, 'state.db') };
}

test('fake runtime start is idempotent for the same Ariad run id', async () => {
  const runtime = createFakeRuntimeAdapter();
  const first = await runtime.start({ runId: 'RUN-42', role: 'developer', task: { id: 'T' }, context: {} });
  const second = await runtime.start({ runId: 'RUN-42', role: 'developer', task: { id: 'T' }, context: {} });
  assert.equal(first.externalId, second.externalId);
  assert.equal(runtime.executionCount, 1);
  assert.equal(runtime.calls.filter(x => x.operation === 'start').at(-1).duplicate, true);
});

test('crash after runtime start but before external id persistence can be safely redispatched', async () => {
  const { dir, file } = tempDb();
  const store1 = new SQLiteRunStore(file);
  const runtime = createFakeRuntimeAdapter({ script: [{ outcome: 'IMPLEMENTATION_READY', result: { ok: true } }] });
  const registry = new RuntimeRegistry();
  registry.register('fake', runtime);

  const run = store1.create({ taskId: 'T-crash', role: 'developer', runtimeKey: 'fake', runtimeId: 'fake', context: { taskId: 'T-crash' } });
  store1.update(run.id, { state: 'DISPATCHING' });
  const external = await runtime.start({ runId: run.id, role: 'developer', task: { id: 'T-crash' }, context: { taskId: 'T-crash' } });
  assert.equal(external.externalId, `fake:${run.id}`);
  store1.close();

  const store2 = new SQLiteRunStore(file);
  const observations = await new RunReconciler({ store: store2, registry }).reconcile();
  assert.equal(observations[0].type, 'RUN_READY_TO_REDISPATCH');
  assert.equal(observations[0].previousState, 'DISPATCHING');

  const executor = new RuntimeExecutor({ registry, runStore: store2 });
  const result = await executor.redispatch(run.id);
  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(runtime.executionCount, 1, 'redispatch must attach to the existing execution');
  assert.equal(store2.get(run.id).state, 'COMPLETED');
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redispatch never creates a second Ariad Run or increments semantic attempt', async () => {
  const { dir, file } = tempDb();
  const store = new SQLiteRunStore(file);
  const runtime = createFakeRuntimeAdapter({ script: [{ outcome: 'PASS' }] });
  const registry = new RuntimeRegistry();
  registry.register('fake', runtime);
  const run = store.create({ taskId: 'T1', role: 'tester', runtimeKey: 'fake', runtimeId: 'fake', context: { taskId: 'T1' } });
  store.update(run.id, { state: 'DISPATCHING' });
  await runtime.start({ runId: run.id, role: 'tester', task: { id: 'T1' }, context: { taskId: 'T1' } });

  const executor = new RuntimeExecutor({ registry, runStore: store });
  await executor.redispatch(run.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(run.id).attempt, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
