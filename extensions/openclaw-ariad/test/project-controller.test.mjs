import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AriadProjectController } from '../runtime/project-controller.js';

class ScriptedRuntimeAdapter {
  id = 'scripted-project';
  runs = new Map();
  sequence = 0;

  async install() { return { installed: true }; }
  async probe() { return { health: 'HEALTHY' }; }
  async start(input) {
    const externalId = `script-${++this.sequence}`;
    this.runs.set(externalId, input);
    return { runtimeId: this.id, runId: input.runId, externalId, state: 'RUNNING' };
  }
  async resume(input) { return this.start(input); }
  async cancel() { return { state: 'CANCELLED' }; }
  async poll(handle) {
    const input = this.runs.get(handle.externalId);
    const cycle = input.context?.devCycle ?? 0;
    if (input.role === 'pm') {
      return { state: 'COMPLETED', outcome: 'REPLANNED', result: { tasks: [{ id: 'T1', acceptanceCriteria: ['passes after one review retry'], dependsOn: [] }] } };
    }
    if (input.role === 'developer') return { state: 'COMPLETED', outcome: 'IMPLEMENTATION_READY', result: { cycle } };
    if (input.role === 'tester') return { state: 'COMPLETED', outcome: 'PASS', result: { cycle } };
    if (input.role === 'reviewer' && cycle === 1) return { state: 'COMPLETED', outcome: 'NOT_PASS', result: { cycle } };
    if (input.role === 'reviewer') return { state: 'COMPLETED', outcome: 'PASS', result: { cycle } };
    throw new Error(`unexpected role ${input.role}`);
  }
}

test('AriadProjectController plans then converges through reviewer retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-project-controller-'));
  try {
    const ariad = join(root, '.ariad');
    mkdirSync(ariad, { recursive: true });
    const stateDb = join(ariad, 'state.db');
    const controller = new AriadProjectController({
      project: { id: 'p1', root, stateDb, goal: 'build a tiny feature' },
      runtimeAdapter: new ScriptedRuntimeAdapter(),
    });

    await controller.start();
    while (controller.status().active) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(controller.status().phase, 'SUCCEEDED', JSON.stringify(controller.status()));

    const db = new DatabaseSync(stateDb, { readOnly: true });
    const state = db.prepare('SELECT dev_cycle, status FROM workflow_state WHERE task_id = ?').get('T1');
    const runs = db.prepare('SELECT role, attempt, state FROM runs ORDER BY seq').all();
    db.close();
    assert.equal(state.status, 'SUCCEEDED');
    assert.equal(state.dev_cycle, 2);
    assert.deepEqual(runs.map((run) => run.role), ['pm', 'developer', 'tester', 'reviewer', 'developer', 'tester', 'reviewer']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
