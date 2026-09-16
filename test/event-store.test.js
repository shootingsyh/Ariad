import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileEventStore } from '../src/event-store.js';

test('event store is append-only and replayable',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ariad-'));
  const file=path.join(dir,'events.jsonl');
  const s=new FileEventStore(file);
  s.append({type:'TASK_CREATED',taskId:'T1'});
  s.append({type:'RUN_FAILED',taskId:'T1',runId:'R1'});
  assert.deepEqual(s.readAll().map(e=>e.type),['TASK_CREATED','RUN_FAILED']);
});

test('event store rejects malformed events before writing',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ariad-'));
  const file=path.join(dir,'events.jsonl');
  const s=new FileEventStore(file);
  assert.throws(()=>s.append(null),/event/);
  assert.equal(fs.existsSync(file),false);
});
