import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';

test('stores offer named task queries only - no generic listTasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-listfilter-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  assert.equal(store.listTasks, undefined);
  assert.deepEqual(store.listAllTasks('P'), []);
  assert.deepEqual(store.listTasksByStates('P', ['READY']), []);
  assert.deepEqual(store.listTasksByFlow('P', 'planner:P:b1'), []);
  assert.deepEqual(store.listTasksByScope('P', 'delivery'), []);
});
