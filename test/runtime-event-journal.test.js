import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeExecutor } from '../src/runtime-executor.js';
import { InMemoryRunStore } from '../src/run-store.js';
import { SQLiteEventJournal } from '../src/sqlite-event-journal.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-events-'));
  return path.join(dir, name);
}

test('runtime executor journals create dispatch start and completion in order', async () => {
  const journal = new SQLiteEventJournal(tempDb('events.db'));
  const runStore = new InMemoryRunStore();
  const adapter = createFakeRuntimeAdapter({ script:[{ outcome:'IMPLEMENTATION_READY', result:{ok:true} }] });
  const executor = new RuntimeExecutor({
    registry:{ get:() => adapter },
    runStore,
    eventJournal:journal,
    roleRuntimeMap:{ developer:'fake_runtime' },
  });
  const result = await executor.run('developer', { taskId:'TASK-EVENTS' });
  const events = journal.list({ aggregateType:'run', aggregateId:result.runId });
  assert.deepEqual(events.map(e => e.type), [
    'RUN_CREATED',
    'RUN_DISPATCHING',
    'RUN_STARTED',
    'RUN_COMPLETED',
  ]);
  journal.close();
});
