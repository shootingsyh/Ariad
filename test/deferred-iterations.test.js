import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { activateDeferredIterations } from '../src/v2/deferred-iterations.js';

function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ariad-deferred-iterate-'));
 const ws=path.join(root,'workspace');const db=path.join(ws,'.ariad','state.db');
 fs.mkdirSync(path.dirname(db),{recursive:true});
 const store=new SQLiteV2Store(db);
 store.createProject({id:'demo',projectVersion:1,activeVersion:2,planningModelVersion:2,planningModelMigration:{status:'REBUILDING'},deliveryEnabled:true});
 const report=path.join(ws,'.ariad','docs','review.md');
 fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'Review with real evidence\n');
 const dir=path.join(ws,'.ariad','iterations','requests');
 fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'iterate.json');
 const entry={
  schemaVersion:1,id:'demo:v2:decomposition',projectId:'demo',kind:'ITERATE',
  status:'DEFERRED_UNTIL_MIGRATION_COMPLETE',targetVersion:2,baselineCompletedVersion:1,
  reviewReport:report,reviewSha256:createHash('sha256').update(fs.readFileSync(report)).digest('hex'),
  request:{purpose:'UPDATE_DELIVERY_PLAN',iteration:2,changeType:'FEATURE_DECOMPOSITION'},
 };
 fs.writeFileSync(file,JSON.stringify(entry));
 return {root,ws,store,file,entry};
}
function setMigration(store,status){
 const p=store.getProject('demo');
 store.updateProject('demo',p.version,{planningModelMigration:{status}});
}
test('deferred iteration stays gated until migration completes, then queues once and disables delivery',()=>{
 const f=fixture();
 try {
  assert.deepEqual(activateDeferredIterations({store:f.store,projectId:'demo',workspace:f.ws}),[]);
  assert.equal(f.store.getPlanningRequest(f.entry.id),null);
  setMigration(f.store,'COMPLETED');
  assert.deepEqual(activateDeferredIterations({store:f.store,projectId:'demo',workspace:f.ws}),[f.entry.id]);
  assert.equal(f.store.getPlanningRequest(f.entry.id).request.changeType,'FEATURE_DECOMPOSITION');
  assert.equal(f.store.getProject('demo').deliveryEnabled,false);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).status,'QUEUED');
  assert.deepEqual(activateDeferredIterations({store:f.store,projectId:'demo',workspace:f.ws}),[]);
  assert.equal(f.store.listPlanningRequests('demo').length,1);
 } finally{f.store.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('deferred iteration refuses version drift and altered review evidence',()=>{
 const f=fixture();
 try{
  setMigration(f.store,'COMPLETED');
  fs.writeFileSync(f.entry.reviewReport,'Modified behind the user review\n');
  assert.throws(()=>activateDeferredIterations({store:f.store,projectId:'demo',workspace:f.ws}),/hash mismatch/);
  assert.equal(f.store.listPlanningRequests('demo').length,0);
  fs.writeFileSync(f.entry.reviewReport,'Review with real evidence\n');
  const changed={...f.entry,targetVersion:3};
  fs.writeFileSync(f.file,JSON.stringify(changed));
  assert.throws(()=>activateDeferredIterations({store:f.store,projectId:'demo',workspace:f.ws}),/version tuple/);
  assert.equal(f.store.listPlanningRequests('demo').length,0);
 }finally{f.store.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
