import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';

// A pending human decision pauses NEW delivery dispatch, not the
// reconcile loop (owner option 1, 2026-11-24). The scheduler side of
// that rule is the pauseDelivery flag: delivery-scope tasks are not
// dispatch candidates, while planning-batch claims and planner-task
// dispatch keep moving - a decision delivered as a replan is claimed
// and planned by the same loop the wait used to suspend wholesale
// (SRPG 2026-11-23/24 deadlock).
function makeScheduler(store) {
  const roles = new RoleRegistry();
  for (const stage of ['developer', 'tech_lead', 'tech_lead_critic', 'plan_validator', 'pm']) {
    roles.register(stage, { prepare: () => ({ provider: 'fake' }), transition: () => ({ state: 'DONE' }) });
  }
  const providers = new ProviderRegistry();
  providers.register({ id: 'fake', start: async () => ({ externalId: 'ex' }), poll: async () => ({ state: 'RUNNING' }), cancel: async () => {} });
  return new V2Scheduler({ store, roles, providers, resources: new ResourcePool({}) });
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-pause-delivery-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  store.createProject({ id: 'P' });
  return { dir, store };
}

test('pauseDelivery: a pending replan is claimed and planned while delivery dispatch waits', async () => {
  const { dir, store } = makeStore();
  try {
    store.createTask({ projectId: 'P', scope: 'delivery', stage: 'developer', id: 't-delivery', taskKind: 'FEATURE_TASK', featureId: 'f1', dependsOn: [] });
    store.enqueuePlanningRequest({
      id: 'replan-1', projectId: 'P',
      request: { purpose: 'LOCAL_REPLAN', instruction: 'Defer the gated milestone.' },
      context: {},
    });
    const scheduler = makeScheduler(store);
    const result = await scheduler.tick('P', { pauseDelivery: true });
    const requests = store.listPlanningRequests('P');
    assert.equal(requests[0].state, 'CLAIMED');
    assert.ok(!result.started.includes('t-delivery'), 'delivery task must not dispatch under pauseDelivery');
    assert.equal(store.getTask('t-delivery').state, 'READY');
    const working = store.listTasksByStates('P', ['WORKING']);
    assert.ok(working.some(task => task.taskKind === 'PLANNING'), 'a planner task should be running under pauseDelivery');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pauseDelivery: without any planning work, a runnable delivery task simply waits', async () => {
  const { dir, store } = makeStore();
  try {
    store.createTask({ projectId: 'P', scope: 'delivery', stage: 'developer', id: 't-delivery', taskKind: 'FEATURE_TASK', featureId: 'f1', dependsOn: [] });
    const scheduler = makeScheduler(store);
    const result = await scheduler.tick('P', { pauseDelivery: true });
    assert.deepEqual(result.started, []);
    assert.equal(store.getTask('t-delivery').state, 'READY');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: without pauseDelivery the same delivery task dispatches', async () => {
  const { dir, store } = makeStore();
  try {
    store.createTask({ projectId: 'P', scope: 'delivery', stage: 'developer', id: 't-delivery', taskKind: 'FEATURE_TASK', featureId: 'f1', dependsOn: [] });
    const scheduler = makeScheduler(store);
    const result = await scheduler.tick('P', {});
    assert.deepEqual(result.started, ['t-delivery']);
    assert.equal(store.getTask('t-delivery').state, 'WORKING');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
