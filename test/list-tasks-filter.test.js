import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';

test('listTasks refuses a bare full list - a selector is required', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-listfilter-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  assert.throws(() => store.listTasks('P'), /requires an explicit filter/);
  assert.throws(() => store.listTasks('P', {}), /requires an explicit filter/);
  assert.throws(() => store.listTasks('P', { states: [] }), /requires an explicit filter/);
  assert.deepEqual(store.listTasks('P', { all: true }), []);
  assert.deepEqual(store.listTasks('P', { states: ['READY'] }), []);
  assert.deepEqual(store.listTasks('P', { flowId: 'planner:P:b1' }), []);
  assert.deepEqual(store.listTasks('P', { scope: 'delivery' }), []);
});
