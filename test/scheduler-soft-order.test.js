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

// Owner soft order (2026-11-22): among runnable candidates, feature work
// dispatches before integration work and milestones last - the expensive
// whole-product checks must not fire before the leaf work they verify
// has landed. Inside a tier, deeper feature-tree work goes first. The
// order is soft: dependsOn still decides who is a candidate at all.
test('scheduler soft order: feature before integration before milestone, deeper feature first, dependsOn still hard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-soft-order-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P' });
    const base = { projectId: 'P', scope: 'delivery', stage: 'developer' };
    store.createTask({ ...base, id: 't-deep', taskKind: 'FEATURE_TASK', featureId: 'f-leaf', dependsOn: [] });
    store.createTask({ ...base, id: 't-shallow', taskKind: 'FEATURE_TASK', featureId: 'f-root', dependsOn: [] });
    store.createTask({ ...base, id: 't-int', taskKind: 'INTEGRATION_TASK', featureId: 'f-mid', dependsOn: [] });
    store.createTask({ ...base, id: 't-ms', taskKind: 'MILESTONE_TASK', milestoneId: 'V1', dependsOn: [] });
    // t-sink is not runnable; it only lends downstream impact to t-int
    // and t-shallow, which the old impact-first order would dispatch
    // ahead of t-deep.
    store.createTask({ ...base, id: 't-sink', taskKind: 'FEATURE_TASK', featureId: 'f-mid', dependsOn: ['t-int', 't-shallow'] });
    // Top tier and deepest feature, but its dependency is unfinished:
    // the soft order must never make it a candidate.
    store.createTask({ ...base, id: 't-blocked', taskKind: 'FEATURE_TASK', featureId: 'f-leaf', dependsOn: ['t-int'] });
    store.featureDepths = () => new Map([['f-root', 1], ['f-mid', 2], ['f-leaf', 3]]);
    const roles = new RoleRegistry();
    roles.register('developer', { prepare: () => ({ provider: 'fake' }), transition: () => ({ state: 'DONE' }) });
    const providers = new ProviderRegistry();
    providers.register({ id: 'fake', start: async () => ({ externalId: 'ex' }), poll: async () => ({ state: 'RUNNING' }), cancel: async () => {} });
    const scheduler = new V2Scheduler({ store, roles, providers, resources: new ResourcePool({}) });
    const result = await scheduler.tick('P');
    assert.deepEqual(result.started, ['t-deep', 't-shallow', 't-int', 't-ms']);
    assert.equal(store.getTask('t-blocked').state, 'READY');
    assert.equal(store.getTask('t-sink').state, 'READY');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
