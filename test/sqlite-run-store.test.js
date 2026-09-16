import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteRunStore } from '../src/sqlite-run-store.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-sqlite-'));
  return { dir, file: path.join(dir, 'state.db') };
}

test('sqlite run store persists runs across process-style reopen', () => {
  const { dir, file } = tempDb();
  try {
    const first = new SQLiteRunStore(file);
    const run = first.create({ taskId: 'T1', role: 'developer', runtimeKey: 'fake', context: { x: 1 } });
    first.update(run.id, { state: 'RUNNING', externalId: 'fake:1' });
    first.close();

    const second = new SQLiteRunStore(file);
    const restored = second.get(run.id);
    assert.equal(restored.state, 'RUNNING');
    assert.equal(restored.externalId, 'fake:1');
    assert.deepEqual(restored.context, { x: 1 });
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attempt numbering survives restart', () => {
  const { dir, file } = tempDb();
  try {
    const first = new SQLiteRunStore(file);
    const run1 = first.create({ taskId: 'T2', role: 'tester', runtimeKey: 'fake' });
    assert.equal(run1.attempt, 1);
    first.close();

    const second = new SQLiteRunStore(file);
    const run2 = second.create({ taskId: 'T2', role: 'tester', runtimeKey: 'fake' });
    assert.equal(run2.attempt, 2);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart reconciliation finds only non-terminal runs', () => {
  const { dir, file } = tempDb();
  try {
    const first = new SQLiteRunStore(file);
    const created = first.create({ taskId: 'T3', role: 'developer', runtimeKey: 'fake' });
    const running = first.create({ taskId: 'T4', role: 'tester', runtimeKey: 'fake' });
    const done = first.create({ taskId: 'T5', role: 'reviewer', runtimeKey: 'fake' });
    first.update(running.id, { state: 'RUNNING', externalId: 'fake:r2' });
    first.update(done.id, { state: 'COMPLETED', result: { outcome: 'PASS' } });
    first.close();

    const second = new SQLiteRunStore(file);
    const recoverable = second.listRecoverable();
    assert.deepEqual(recoverable.map(run => run.id), [created.id, running.id]);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal runs are never returned for recovery after restart', () => {
  const { dir, file } = tempDb();
  try {
    const first = new SQLiteRunStore(file);
    for (const state of ['COMPLETED', 'FAILED', 'LOST', 'CANCELLED']) {
      const run = first.create({ taskId: `T-${state}`, role: 'developer', runtimeKey: 'fake' });
      first.update(run.id, { state });
    }
    first.close();

    const second = new SQLiteRunStore(file);
    assert.deepEqual(second.listRecoverable(), []);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
