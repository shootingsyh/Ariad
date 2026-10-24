import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,linkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';
import {prepareUnifiedTaskCutoverOnCopy} from '../src/v2/unified-task-cutover.js';
test('cutover refuses live SQLite hardlinks before inspecting artifacts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-cutover-'));
 const live=join(dir,'live.db'),alias=join(dir,'alias.db');
 const first=new SQLiteV2Store(live);first.close();linkSync(live,alias);
 const store=new SQLiteV2Store(alias);
 try{assert.throws(()=>prepareUnifiedTaskCutoverOnCopy({store,projectId:'p',artifactRoot:'unused',liveDatabasePath:live,isolatedCopyConfirmed:true}),/REFUSES_LIVE_DATABASE/);}
 finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('cutover records only evidence-backed historical exceptions on isolated copy', { skip: !existsSync('/tmp/ariad-verify-unified-37DRE1/state.db') || !existsSync('/home/shootingsyh/srpg-project/game/.ariad/state.db') ? 'requires explicit archived SRPG cutover fixture' : false }, async()=>{
 const {copyFileSync}=await import('node:fs');
 const source='/tmp/ariad-verify-unified-37DRE1/state.db';
 const live='/home/shootingsyh/srpg-project/game/.ariad/state.db';
 const root='/home/shootingsyh/srpg-project/game/.ariad/artifacts';
 const dir=mkdtempSync(join(tmpdir(),'ariad-cutover-integration-'));
 const db=join(dir,'copy.db');copyFileSync(source,db);
 const store=new SQLiteV2Store(db);
 try {
  const before=store.listTasks('srpg',{scope:'delivery'});
  const p=store.getProject('srpg');
  if(p.deliveryEnabled!==false) store.updateProject('srpg',p.version,{deliveryEnabled:false});
  const result=prepareUnifiedTaskCutoverOnCopy({artifactRoot:root,store,projectId:'srpg',liveDatabasePath:live,isolatedCopyConfirmed:true});
  assert.equal(result.prepared,true);
  assert.equal(result.historyConflicts.length,2);
  assert.equal(result.unresolved.length,0);
  assert.equal(store.getProject('srpg').unifiedTaskCompilerVersion,1);
  assert.equal(store.getProject('srpg').deliveryEnabled,false);
  const after=store.listTasks('srpg',{scope:'delivery'});
  assert.deepEqual(after,before);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
