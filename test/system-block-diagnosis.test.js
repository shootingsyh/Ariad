import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import {
  ensureSystemBlockDiagnosis,
  systemIncidentFromHistory,
} from '../src/v2/system-block-diagnosis.js';

const FAILURE = 'PI_PROVIDER_ERROR: 503: {"message":"Loading model"}';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-sysblock-'));
  return { dir, file: path.join(dir, 'state.db') };
}

function blockedDeliveryTask(store, projectId, id = 'T-blocked') {
  store.createTask({
    taskKind: 'MILESTONE_TASK', id, projectId, stage: 'developer', state: 'SYSTEM_BLOCKED',
  });
  const task = store.getTask(id);
  store.appendTaskHistory(id, task.version, {
    type: 'SYSTEM_INTERRUPTION', role: 'developer', failure: FAILURE,
    consumeAttempt: true, at: '2026-11-04T18:00:05.000Z',
  }, { execution: null });
  return store.getTask(id);
}

test('systemIncidentFromHistory: last interruption wins, empty history degrades', () => {
  const task = { stage: 'tester', history: [
    { type: 'SYSTEM_INTERRUPTION', failure: 'first', role: 'developer', consumeAttempt: true, at: 't1' },
    { type: 'ROLE_RESULT', outcome: 'PASS' },
    { type: 'SYSTEM_INTERRUPTION', failure: 'last', role: 'tester', consumeAttempt: false, at: 't2' },
  ] };
  assert.deepEqual(systemIncidentFromHistory(task), {
    code: 'SYSTEM_BLOCKED', failure: 'last', role: 'tester', consumeAttempt: false, at: 't2',
  });
  assert.deepEqual(systemIncidentFromHistory({ stage: 'developer', history: [] }), {
    code: 'SYSTEM_BLOCKED', failure: null, role: 'developer', at: null,
  });
});

test('ensure creates one diagnostic task for a system-blocked delivery task', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-diag' });
    blockedDeliveryTask(store, 'P-diag');
    const first = ensureSystemBlockDiagnosis(store, 'P-diag');
    assert.equal(first.failures.length, 0);
    assert.equal(first.created.length, 1);
    const diagnosis = store.getTask('debug:T-blocked:1');
    assert.ok(diagnosis);
    assert.equal(diagnosis.taskKind, 'DIAGNOSTIC');
    assert.equal(diagnosis.stage, 'project_debugger');
    assert.equal(diagnosis.state, 'READY');
    assert.equal(diagnosis.input.blockedTaskId, 'T-blocked');
    assert.equal(diagnosis.input.systemIncident.code, 'SYSTEM_BLOCKED');
    assert.equal(diagnosis.input.systemIncident.failure, FAILURE);
    // Idempotent while the diagnosis is active.
    const second = ensureSystemBlockDiagnosis(store, 'P-diag');
    assert.equal(second.created.length, 0);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure sequences a fresh diagnosis after the previous one completed', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-diag2' });
    blockedDeliveryTask(store, 'P-diag2');
    ensureSystemBlockDiagnosis(store, 'P-diag2');
    const done = store.getTask('debug:T-blocked:1');
    store.updateTask(done.id, done.version, { state: 'DONE' });
    const again = ensureSystemBlockDiagnosis(store, 'P-diag2');
    assert.equal(again.created.length, 1);
    assert.ok(store.getTask('debug:T-blocked:2'));
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure skips planning tasks, debugger-stage tasks and unblocked tasks', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-diag3' });
    store.createTask({ taskKind: 'PLANNING', id: 'T-plan', projectId: 'P-diag3', stage: 'tech_lead', state: 'SYSTEM_BLOCKED', flowId: 'planner:P-diag3' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-dbg', projectId: 'P-diag3', stage: 'project_debugger', state: 'SYSTEM_BLOCKED' });
    store.createTask({ taskKind: 'MILESTONE_TASK', id: 'T-ready', projectId: 'P-diag3', stage: 'developer', state: 'READY' });
    const { created, failures } = ensureSystemBlockDiagnosis(store, 'P-diag3');
    assert.equal(created.length, 0);
    assert.equal(failures.length, 0);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure stops creating diagnoses once auto-carries are exhausted, until an operator recovery', () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-diag5' });
    blockedDeliveryTask(store, 'P-diag5');
    const carried = {
      type: 'DEBUGGER_ROUTE', role: 'project_debugger', route: 'developer',
      diagnosis: 'SYSTEM_RUNTIME_FAILURE', autoCarried: true, at: '2026-11-04T18:05:00.000Z',
    };
    let task = store.getTask('T-blocked');
    store.appendTaskHistory(task.id, task.version, carried, { execution: null });
    task = store.getTask('T-blocked');
    store.appendTaskHistory(task.id, task.version, carried, { execution: null });
    const exhausted = ensureSystemBlockDiagnosis(store, 'P-diag5');
    assert.equal(exhausted.created.length, 0);
    task = store.getTask('T-blocked');
    store.appendTaskHistory(task.id, task.version, {
      type: 'SYSTEM_RECOVERY', role: 'developer', reason: 'MANUAL_RESUME', at: '2026-11-04T18:10:00.000Z',
    }, { execution: null });
    const afterRecovery = ensureSystemBlockDiagnosis(store, 'P-diag5');
    assert.equal(afterRecovery.created.length, 1);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor audit sweeps a diagnostic task for a pre-blocked delivery task', async () => {
  const { dir, file } = tempDb();
  try {
    const store = new SQLiteV2Store(file);
    store.createProject({ id: 'P-diag4' });
    blockedDeliveryTask(store, 'P-diag4');
    const supervisor = new V2Supervisor({
      store, providers: new ProviderRegistry(), resources: new ResourcePool({}),
    });
    await supervisor.audit('P-diag4');
    const diagnosis = store.getTask('debug:T-blocked:1');
    assert.ok(diagnosis);
    assert.equal(diagnosis.state, 'READY');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
