import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { StandaloneProjectRuntime } from '../src/runtime/standalone-project-runtime.js';

function seedBlockedTask(store, task) {
  store.db.prepare('INSERT INTO v2_tasks (id, project_id, data_json, version, updated_at) VALUES (?, ?, ?, 1, ?)')
    .run(task.id, 'P', JSON.stringify(task), '2026-10-31T00:00:00.000Z');
}

function makeRuntime(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-resume-'));
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  store.createProject({ id: 'P', workspace: dir });
  t.after(() => { try { store.db.close(); } catch { /* already closed by the test */ } rmSync(dir, { recursive: true, force: true }); });
  return { store, file, dir };
}

test('manual resume routes a diagnosed planning block back to the tech lead', (t) => {
  const { store, file, dir } = makeRuntime(t);
  seedBlockedTask(store, {
    id: 'repair-1', taskKind: 'PLANNING', stage: 'project_debugger', state: 'SYSTEM_BLOCKED',
    flowId: 'planner:P:b1',
    input: { purpose: 'PLANNER_DECOMPOSE', planGateRetries: 2, previousGateFailure: { summary: 'two sibling imports' } },
    history: [
      { type: 'PLAN_DEBUGGER_DIAGNOSIS', outcome: 'WRONG_IMPLEMENTATION_APPROACH', guidance: 'No one-file repair can pass.' },
    ],
  });
  seedBlockedTask(store, {
    id: 'delivery-1', taskKind: 'FEATURE_TASK', stage: 'project_debugger', state: 'SYSTEM_BLOCKED',
    input: {}, history: [{ type: 'SYSTEM_INTERRUPTION', failure: 'PI_RUN_NOT_FOUND' }],
  });
  store.db.close();

  const runtime = new StandaloneProjectRuntime({
    project: { id: 'P', workspace: dir, stateDb: file },
    provider: { id: 'fake', start: async () => {}, poll: async () => {}, cancel: async () => {} },
    resolveRoleModel: () => null,
  });
  const recovered = runtime.resumeSystemBlocked('MANUAL_RESUME_AFTER_FAILED_PROJECT');
  assert.deepEqual(recovered.sort(), ['delivery-1', 'repair-1']);

  const repair = runtime.store.getTask('repair-1');
  assert.equal(repair.state, 'READY');
  assert.equal(repair.stage, 'tech_lead');
  assert.equal(repair.input.planGateRetries, 0);
  assert.equal(repair.input.previousGateFailure.summary, 'two sibling imports');
  assert.ok(repair.history.some(h => h.type === 'PLAN_DEBUGGER_DIAGNOSIS'));
  const recovery = repair.history.find(h => h.type === 'SYSTEM_RECOVERY');
  assert.equal(recovery.recoveredToStage, 'tech_lead');

  // A blocked task without a planning diagnosis keeps its stage.
  const delivery = runtime.store.getTask('delivery-1');
  assert.equal(delivery.state, 'READY');
  assert.equal(delivery.stage, 'project_debugger');
  runtime.store.db.close();
});
