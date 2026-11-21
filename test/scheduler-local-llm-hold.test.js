import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { V2Scheduler, activeLocalLlmHolder } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';

test('activeLocalLlmHolder only honors live pipeline states', () => {
  assert.equal(activeLocalLlmHolder([{ id: 'x', state: 'READY' }], null), null);
  assert.equal(activeLocalLlmHolder([{ id: 'x', state: 'READY' }], 'missing'), null);
  for (const state of ['READY', 'WORKING', 'RESULT_READY']) {
    assert.equal(activeLocalLlmHolder([{ id: 'x', state }], 'x')?.id, 'x', state);
  }
  for (const state of ['DONE', 'SKIPPED', 'OBSOLETE', 'NEEDS_HUMAN', 'SYSTEM_BLOCKED', 'BLOCKED']) {
    assert.equal(activeLocalLlmHolder([{ id: 'x', state }], 'x'), null, state);
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-local-hold-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  store.createProject({ id: 'p', spec: 'fixture', deliveryEnabled: true, unifiedTaskCompilerVersion: 1, deliveryPlanVersion: 3 });
  const mk = (id, extra = {}) => ({
    id, projectId: 'p', taskKind: 'MILESTONE_TASK', stage: 'developer', state: 'READY',
    milestoneId: 'A', executionMode: 'implementation', unifiedTaskSchemaVersion: 1,
    dependsOn: [], interfaceIds: ['iface'], input: { interfaceIds: ['iface'], milestoneId: 'A' }, history: [], ...extra,
  });
  const roles = new RoleRegistry();
  for (const role of ['developer', 'test_engineer', 'tester', 'reviewer']) roles.register(role, {
    prepare: () => ({ provider: 'fake', resources: ['local-llm'] }),
    transition: () => { throw new Error('legacy role transition invoked'); },
  });
  let counter = 0;
  const statuses = new Map(); const starts = [];
  const provider = {
    id: 'fake',
    async start(spec) { const externalId = `f-${++counter}`; starts.push(`${spec.taskId}:${spec.role}`); statuses.set(externalId, { state: 'RUNNING' }); return { externalId }; },
    async poll({ externalId }) { return statuses.get(externalId); },
    async cancel() {},
  };
  const providers = new ProviderRegistry(); providers.register(provider);
  const resources = new ResourcePool({ 'local-llm': 1 });
  return {
    dir, store, mk, starts, statuses,
    scheduler: new V2Scheduler({ store, roles, providers, resources }),
    supervisor: new V2Supervisor({ store, providers, resources }),
  };
}

async function runStage(fx, id, role) {
  if (fx.store.getTask(id).state !== 'WORKING') await fx.scheduler.tick('p');
  const task = fx.store.getTask(id);
  assert.equal(task.state, 'WORKING', `${id} should be WORKING at ${role}`);
  assert.equal(task.stage, role);
  fx.statuses.set(task.execution.externalId, {
    state: 'COMPLETED', outcome: 'PASS',
    result: role === 'test_engineer'
      ? { testPlan: { testCases: [{ entry: 'src/index.js', command: 'node --check src/index.js', covers: [], executionScope: ['src/index.js'] }] } }
      : {},
  });
  await fx.supervisor.audit('p');
  assert.equal(fx.store.getTask(id).state, 'RESULT_READY');
}

test('local-llm hold keeps one task atomic until DONE, then hands over', async () => {
  const fx = fixture();
  try {
    fx.store.createTask(fx.mk('holder'));
    await fx.scheduler.tick('p');
    assert.deepEqual(fx.starts, ['holder:developer']);
    assert.equal(fx.store.getProject('p').localLlmHolderTaskId, 'holder');

    // An issue-queue task outranks the milestone tree in normal ordering;
    // while the hold stands it must not interleave between stages.
    fx.store.createTask(fx.mk('fix-rival', { queue: 'issue', input: { interfaceIds: ['iface'], milestoneId: 'A', queue: 'issue' } }));
    await runStage(fx, 'holder', 'developer');
    const started = await fx.scheduler.tick('p');
    assert.deepEqual(started.started, ['holder']);
    assert.equal(fx.store.getTask('holder').stage, 'test_engineer');
    assert.equal(fx.store.getTask('fix-rival').state, 'READY');

    for (const role of ['test_engineer', 'tester', 'reviewer']) {
      await runStage(fx, 'holder', role);
      assert.equal(fx.store.getTask('fix-rival').state, 'READY', `rival must wait during holder ${role}`);
    }
    await fx.scheduler.tick('p');
    assert.equal(fx.store.getTask('holder').state, 'DONE');
    // The handover happens in the same tick that settles the holder:
    // the rival starts immediately and takes the hold.
    assert.deepEqual(fx.starts.filter(x => x.startsWith('fix-rival')), ['fix-rival:developer']);
    assert.equal(fx.store.getProject('p').localLlmHolderTaskId, 'fix-rival');
  } finally { fx.store.close(); rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a parked holder releases the local model to the next task', async () => {
  const fx = fixture();
  try {
    fx.store.createTask(fx.mk('holder'));
    await fx.scheduler.tick('p');
    assert.equal(fx.store.getProject('p').localLlmHolderTaskId, 'holder');
    await runStage(fx, 'holder', 'developer');

    const parked = fx.store.getTask('holder');
    fx.store.updateTask('holder', parked.version, { state: 'NEEDS_HUMAN', execution: null });

    fx.store.createTask(fx.mk('next'));
    const started = await fx.scheduler.tick('p');
    assert.deepEqual(started.started, ['next']);
    assert.equal(fx.store.getProject('p').localLlmHolderTaskId, 'next');
  } finally { fx.store.close(); rmSync(fx.dir, { recursive: true, force: true }); }
});
