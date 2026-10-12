import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,linkSync} from 'node:fs';
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
