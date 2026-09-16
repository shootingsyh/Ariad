import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeExecutor } from '../src/runtime-executor.js';
import { SQLiteRunStore } from '../src/sqlite-run-store.js';
import { SQLiteCheckpointStore } from '../src/sqlite-checkpoint-store.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-resume-'));
  return path.join(dir, name);
}

test('lost run resumes from latest safe checkpoint without creating new run attempt', async () => {
  const db = tempDb('state.db');
  const runStore = new SQLiteRunStore(db);
  const checkpointStore = new SQLiteCheckpointStore(db);
  const adapter = createFakeRuntimeAdapter({ script:[{ outcome:'IMPLEMENTATION_READY', result:{ok:true} }] });
  const registry = { get: key => { assert.equal(key, 'fake_runtime'); return adapter; } };

  const run = runStore.create({ taskId:'TASK-1', role:'developer', runtimeKey:'fake_runtime', runtimeId:'fake', context:{taskId:'TASK-1'} });
  runStore.update(run.id, { state:'LOST', failure:{kind:'RUN_LOST'} });
  checkpointStore.write({ runId:run.id, sequence:1, safeToResume:true, payload:{completed:['edit'], remaining:['test']} });
  checkpointStore.write({ runId:run.id, sequence:2, safeToResume:false, payload:{completed:['edit','partial-test']} });

  const executor = new RuntimeExecutor({ registry, runStore, checkpointStore });
  const result = await executor.resume(run.id);

  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.runId, run.id);
  assert.equal(runStore.list().length, 1);
  assert.equal(runStore.get(run.id).attempt, 1);
  const resumeCall = adapter.calls.find(c => c.operation === 'resume');
  assert.equal(resumeCall.runId, run.id);
  assert.equal(resumeCall.checkpoint.sequence, 1);
  checkpointStore.close();
  runStore.close();
});

test('resume refuses run without a safe checkpoint', async () => {
  const db = tempDb('state.db');
  const runStore = new SQLiteRunStore(db);
  const checkpointStore = new SQLiteCheckpointStore(db);
  const adapter = createFakeRuntimeAdapter();
  const registry = { get: () => adapter };
  const run = runStore.create({ taskId:'TASK-2', role:'developer', runtimeKey:'fake_runtime', runtimeId:'fake' });
  runStore.update(run.id, { state:'LOST' });
  checkpointStore.write({ runId:run.id, sequence:1, safeToResume:false, payload:{} });
  const executor = new RuntimeExecutor({ registry, runStore, checkpointStore });
  await assert.rejects(() => executor.resume(run.id), /no safe checkpoint/);
  checkpointStore.close();
  runStore.close();
});
