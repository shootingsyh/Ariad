import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';
test('legacy delivery compiler cannot overwrite migrated unified task tree',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-compiler-guard-'));
 const store=new SQLiteV2Store(join(dir,'state.db'));
 try {
  store.db.prepare('INSERT INTO v2_projects(id,data_json,version,updated_at) VALUES(?,?,?,?)').run('p',JSON.stringify({id:'p'}),1,'2026-01-01');
  store.db.prepare('INSERT INTO v2_tasks(id,project_id,data_json,version,updated_at) VALUES(?,?,?,?,?)').run('parent','p',JSON.stringify({scope:'delivery',state:'READY',stage:'developer',unifiedTaskSchemaVersion:1,executionMode:'aggregate'}),1,'2026-01-01');
  assert.throws(()=>store.applyDeliveryPlan('p',{version:3,tasks:[{id:'legacy'}]}),/UNIFIED_TASK_TREE_REQUIRES_COMPATIBLE_COMPILER/);
  assert.equal(store.listTasks('p',{scope:'delivery'}).length,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
