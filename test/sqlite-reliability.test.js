import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteIncidentStore } from '../src/sqlite-incident-store.js';
import { ReliabilityService } from '../src/reliability.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-incidents-'));
  return { dir, file: path.join(dir, 'state.db') };
}

test('incident state survives Ariad restart', () => {
  const { dir, file } = tempDb();
  const store1 = new SQLiteIncidentStore(file);
  const service1 = new ReliabilityService({ incidentStore: store1 });
  const incident = service1.detect('RUN_LOST', 'RUN-9');
  assert.equal(incident.state, 'OPEN');
  store1.close();

  const store2 = new SQLiteIncidentStore(file);
  const service2 = new ReliabilityService({ incidentStore: store2 });
  assert.equal(service2.get(incident.id).target, 'RUN-9');
  assert.equal(service2.list().length, 1);
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failed recovery step persists and resumes at the next step after restart', async () => {
  const { dir, file } = tempDb();
  const store1 = new SQLiteIncidentStore(file);
  const seen1 = [];
  const service1 = new ReliabilityService({
    incidentStore: store1,
    policies: { RUN_LOST: ['resume_checkpoint', 'new_session'] },
    execute: async action => { seen1.push(action); return false; },
  });
  const incident = service1.detect('RUN_LOST', 'RUN-10');
  const first = await service1.recover(incident.id);
  assert.equal(first.state, 'ESCALATED');
  assert.deepEqual(seen1, ['resume_checkpoint', 'new_session']);
  assert.equal(first.recoveryStep, 2);
  store1.close();

  const store2 = new SQLiteIncidentStore(file);
  const seen2 = [];
  const service2 = new ReliabilityService({
    incidentStore: store2,
    policies: { RUN_LOST: ['resume_checkpoint', 'new_session'] },
    execute: async action => { seen2.push(action); return true; },
  });
  const second = await service2.recover(incident.id);
  assert.equal(second.state, 'ESCALATED');
  assert.deepEqual(seen2, [], 'completed ladder must not restart from step zero');
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('crash during a recovery action replays the same idempotent action after restart', async () => {
  const { dir, file } = tempDb();
  const store1 = new SQLiteIncidentStore(file);
  const service1 = new ReliabilityService({
    incidentStore: store1,
    policies: { MODEL_UNHEALTHY: ['restart_model', 'quarantine'] },
    execute: async action => {
      if (action === 'restart_model') throw new Error('process died during restart');
      return false;
    },
  });
  const incident = service1.detect('MODEL_UNHEALTHY', 'qwen-local');
  await assert.rejects(() => service1.recover(incident.id), /process died/);
  const interrupted = service1.get(incident.id);
  assert.equal(interrupted.recoveryStep, 0);
  assert.equal(interrupted.activeAction, 'restart_model');
  store1.close();

  const store2 = new SQLiteIncidentStore(file);
  const seen = [];
  const service2 = new ReliabilityService({
    incidentStore: store2,
    policies: { MODEL_UNHEALTHY: ['restart_model', 'quarantine'] },
    execute: async action => { seen.push(action); return action === 'restart_model'; },
  });
  const recovered = await service2.recover(incident.id);
  assert.equal(recovered.state, 'RECOVERED');
  assert.deepEqual(seen, ['restart_model']);
  assert.equal(recovered.recoveryStep, 1);
  assert.equal(recovered.activeAction, null);
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
