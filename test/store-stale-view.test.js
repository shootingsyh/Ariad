import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store, isStaleStoreViewError } from '../src/v2/sqlite-store.js';
import { StandaloneProjectRuntime } from '../src/runtime/standalone-project-runtime.js';

function malformed() {
  const error = new Error('database disk image is malformed');
  error.errcode = 11;
  return error;
}

test('classifier: stale-view signatures are recognized', () => {
  assert.equal(isStaleStoreViewError(null), false);
  assert.equal(isStaleStoreViewError(new Error('boom')), false);
  const io = new Error('disk I/O error'); io.errcode = 10;
  assert.equal(isStaleStoreViewError(io), true);
  assert.equal(isStaleStoreViewError(malformed()), true);
  assert.equal(isStaleStoreViewError(new Error('database disk image is malformed')), true);
  assert.equal(isStaleStoreViewError(new Error('audit failed', { cause: malformed() })), true);
  assert.equal(isStaleStoreViewError(new Error('audit failed', { cause: new Error('boom') })), false);
});

function makeRuntime(t, runtimeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-stale-'));
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  store.createProject({ id: 'P', workspace: dir });
  store.db.close();
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return new StandaloneProjectRuntime({
    project: { id: 'P', workspace: dir, stateDb: file },
    provider: { id: 'fake', start: async () => {}, poll: async () => {}, cancel: async () => {} },
    resolveRoleModel: () => null,
    ...runtimeOptions,
  });
}

test('tick reopens the store and retries once on a malformed-view error', async (t) => {
  const runtime = makeRuntime(t);
  const live = runtime.store;
  const originalList = live.listTasks.bind(live);
  let listCalls = 0;
  live.listTasks = (...args) => {
    listCalls += 1;
    if (listCalls === 1) throw malformed();
    return originalList(...args);
  };
  const originalReopen = live.reopen.bind(live);
  let reopenCalls = 0;
  live.reopen = () => { reopenCalls += 1; return originalReopen(); };
  const result = await runtime.tick({ schedule: false });
  assert.equal(reopenCalls, 1);
  assert.ok(result.audit);
  assert.equal(runtime.consecutiveStoreFailures, 0);
  runtime.store.db.close();
});

test('tick reports a fatal store after the threshold of unhealed ticks', async (t) => {
  const fatal = [];
  const runtime = makeRuntime(t, {
    storeFatalThreshold: 3,
    onStoreFatal: (projectId, error) => fatal.push({ projectId, message: error.message }),
  });
  const live = runtime.store;
  live.listTasks = () => { throw malformed(); };
  let reopenCalls = 0;
  live.reopen = () => { reopenCalls += 1; };
  await assert.rejects(runtime.tick({ schedule: false }), /malformed/);
  await assert.rejects(runtime.tick({ schedule: false }), /malformed/);
  assert.equal(fatal.length, 0);
  await assert.rejects(runtime.tick({ schedule: false }), /malformed/);
  assert.equal(reopenCalls, 3);
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0].projectId, 'P');
  runtime.store.db.close();
});

test('a healed tick resets the consecutive-failure count', async (t) => {
  const fatal = [];
  const runtime = makeRuntime(t, {
    storeFatalThreshold: 2,
    onStoreFatal: (projectId, error) => fatal.push({ projectId, message: error.message }),
  });
  const live = runtime.store;
  const originalList = live.listTasks.bind(live);
  let failing = true;
  live.listTasks = (...args) => {
    if (failing) throw malformed();
    return originalList(...args);
  };
  live.reopen = () => {};
  await assert.rejects(runtime.tick({ schedule: false }), /malformed/);
  assert.equal(runtime.consecutiveStoreFailures, 1);
  failing = false;
  const result = await runtime.tick({ schedule: false });
  assert.ok(result.audit);
  assert.equal(runtime.consecutiveStoreFailures, 0);
  failing = true;
  await assert.rejects(runtime.tick({ schedule: false }), /malformed/);
  assert.equal(fatal.length, 0);
  runtime.store.db.close();
});
