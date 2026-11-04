import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import {
  isTransientProviderFailure,
  transientWindowStart,
  transientWindowExpired,
  isInTransientCooldown,
} from '../src/v2/transient-provider-failure.js';

const LOADING = 'PI_PROVIDER_ERROR: 503: {"message":"Loading model"}';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-transient-'));
  return { dir, file: path.join(dir, 'state.db') };
}

function schedulerFixture(store, projectId, failure) {
  const roleRegistry = new RoleRegistry();
  roleRegistry.register('developer', {
    prepare: () => ({ provider: 'broken' }),
    transition: () => ({ state: 'DONE' }),
  });
  const providers = new ProviderRegistry();
  const calls = { starts: 0 };
  providers.register({
    id: 'broken',
    async start() { calls.starts += 1; throw new Error(failure); },
    async poll() { return { state: 'LOST' }; },
    async cancel() {},
  });
  const scheduler = new V2Scheduler({
    store, roles: roleRegistry, providers, resources: new ResourcePool({}),
  });
  return { scheduler, calls };
}

test('transient classification: provider unavailability yes, configuration errors no', () => {
  for (const failure of [
    LOADING,
    'PI_PROVIDER_ERROR: 429: {"message":"rate limit"}',
    'PI_PROVIDER_ERROR: 502: Bad Gateway',
    'connect ECONNREFUSED 127.0.0.1:18080',
    'read ECONNRESET',
    '503 service unavailable',
  ]) assert.equal(isTransientProviderFailure(failure), true, failure);
  for (const failure of [
    'PI_PROVIDER_ERROR: 404: model not found',
    "PI_PROVIDER_ERROR: Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    'provider cannot start role',
    'MISSING_ROLE_RESULT_TOOL',
    '',
    null,
  ]) assert.equal(isTransientProviderFailure(failure), false, String(failure));
});

test('transient window: consecutive transient interruptions, closed by a role result', () => {
  const t0 = '2026-11-04T10:00:00.000Z';
  const t1 = '2026-11-04T10:05:00.000Z';
  const task = { history: [
    { type: 'SYSTEM_INTERRUPTION', transient: true, at: t0 },
    { type: 'SYSTEM_INTERRUPTION', transient: true, at: t1 },
  ] };
  assert.equal(transientWindowStart(task), t0);
  const closed = { history: [
    { type: 'SYSTEM_INTERRUPTION', transient: true, at: t0 },
    { type: 'ROLE_RESULT', at: t1 },
  ] };
  assert.equal(transientWindowStart(closed), null);
  assert.equal(transientWindowStart({ history: [] }), null);
  process.env.ARIAD_TRANSIENT_RETRY_MAX_WINDOW_MS = '60000';
  try {
    const old = { history: [{ type: 'SYSTEM_INTERRUPTION', transient: true, at: new Date(Date.now() - 120000).toISOString() }] };
    assert.equal(transientWindowExpired(old), true);
    const fresh = { history: [{ type: 'SYSTEM_INTERRUPTION', transient: true, at: new Date().toISOString() }] };
    assert.equal(transientWindowExpired(fresh), false);
  } finally {
    delete process.env.ARIAD_TRANSIENT_RETRY_MAX_WINDOW_MS;
  }
  assert.equal(isInTransientCooldown({ retryNotBefore: new Date(Date.now() + 60000).toISOString() }), true);
  assert.equal(isInTransientCooldown({ retryNotBefore: new Date(Date.now() - 60000).toISOString() }), false);
  assert.equal(isInTransientCooldown({ retryNotBefore: null }), false);
});

test('scheduler: transient start failure cools down without consuming attempts or blocking', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-transient' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-transient', projectId: 'P-transient', stage: 'developer' });
    const { scheduler, calls } = schedulerFixture(store, 'P-transient', LOADING);

    await scheduler.tick('P-transient');
    let task = store.getTask('T-transient');
    assert.equal(task.state, 'READY');
    assert.equal(calls.starts, 1);
    assert.ok(Date.parse(task.retryNotBefore) > Date.now());
    const entry = task.history.at(-1);
    assert.equal(entry.type, 'SYSTEM_INTERRUPTION');
    assert.equal(entry.transient, true);
    assert.equal(entry.consumeAttempt, false);

    // Still cooling down: the next tick must not call the provider again.
    await scheduler.tick('P-transient');
    assert.equal(calls.starts, 1);
    assert.equal(store.getTask('T-transient').state, 'READY');

    // Simulate the cooldown elapsing three more times: the task keeps
    // retrying and never blocks, because no attempt is ever consumed.
    for (let round = 0; round < 3; round += 1) {
      const current = store.getTask('T-transient');
      store.updateTask(current.id, current.version, {
        retryNotBefore: new Date(Date.now() - 1000).toISOString(),
      });
      await scheduler.tick('P-transient');
      assert.equal(store.getTask('T-transient').state, 'READY');
    }
    assert.equal(calls.starts, 4);
    task = store.getTask('T-transient');
    assert.equal(
      task.history.filter(e => e?.type === 'SYSTEM_INTERRUPTION' && e?.consumeAttempt !== false).length,
      0,
    );
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler: transient outage outliving the max window escalates to SYSTEM_BLOCKED', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-transient-cap' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-cap', projectId: 'P-transient-cap', stage: 'developer' });
    const seeded = store.getTask('T-cap');
    store.appendTaskHistory(seeded.id, seeded.version, {
      type: 'SYSTEM_INTERRUPTION',
      role: 'developer',
      failure: LOADING,
      consumeAttempt: false,
      transient: true,
      at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }, { execution: null });
    const { scheduler } = schedulerFixture(store, 'P-transient-cap', LOADING);
    await scheduler.tick('P-transient-cap');
    const blocked = store.getTask('T-cap');
    assert.equal(blocked.state, 'SYSTEM_BLOCKED');
    assert.equal(blocked.retryNotBefore, null);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor: transient poll failure parks the task in cooldown instead of the failure ladder', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-transient-sup' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-sup', projectId: 'P-transient-sup', stage: 'developer', state: 'READY' });
    const ready = store.getTask('T-sup');
    store.updateTask(ready.id, ready.version, {
      state: 'WORKING',
      execution: { provider: 'fake', externalId: 'ext-1', attemptId: 'P-transient-sup:T-sup:developer:1' },
    });
    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      async start() { return { externalId: 'ext-1' }; },
      async poll() { return { state: 'LOST', failure: LOADING }; },
      async cancel() {},
    });
    const supervisor = new V2Supervisor({ store, providers, resources: new ResourcePool({}) });
    await supervisor.audit('P-transient-sup');
    const task = store.getTask('T-sup');
    assert.equal(task.state, 'READY');
    assert.ok(Date.parse(task.retryNotBefore) > Date.now());
    const entry = task.history.at(-1);
    assert.equal(entry.type, 'SYSTEM_INTERRUPTION');
    assert.equal(entry.transient, true);
    assert.equal(entry.consumeAttempt, false);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
