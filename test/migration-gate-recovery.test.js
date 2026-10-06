import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { recoverPrematureMigrationApprovalGate } from '../src/v2/migration-gate-recovery.js';

function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ariad-migration-gate-'));
 const store=new SQLiteV2Store(path.join(root,'state.db'));
 store.createProject({
  id:'srpg-fixture',deliveryEnabled:false,
  planningModelMigration:{status:'REBUILDING',fromVersion:1,toVersion:2},
 });
 const task=store.createTask({
  id:'planner:batch-26-26:pm-review',
  projectId:'srpg-fixture',scope:'control',
  flowId:'planner:srpg-fixture:batch-26-26',
  stage:'pm',state:'NEEDS_HUMAN',
  input:{purpose:'PLANNER_PM_REVIEW',planningBatchId:'batch-26-26',versionMigration:true},
  history:[{type:'ROLE_RESULT',role:'pm',outcome:'NEEDS_HUMAN',
    summary:'V2.GATE authorization before delivery',
    result:{startDelivery:false,reason:'Authorize opening V2.1-V2.5 delivery?'}}],
 });
 return {root,store,task};
}
test('premature migration delivery approval is invalidated without granting delivery',()=>{
 const {root,store,task}=fixture();
 try{
  const first=recoverPrematureMigrationApprovalGate(store,'srpg-fixture');
  assert.deepEqual(first,[{taskId:task.id,requestId:'srpg-fixture:migration-revalidate:batch-26-26'}]);
  const updated=store.getTask(task.id);
  assert.equal(updated.state,'DONE');
  assert.equal(updated.history.at(-1).type,'PREMATURE_MIGRATION_DELIVERY_GATE_REJECTED');
  assert.equal(store.getProject('srpg-fixture').deliveryEnabled,false);
  const request=store.getPlanningRequest(first[0].requestId);
  assert.equal(request.request.purpose,'VERSION_MIGRATION_FINALIZE');
  assert.deepEqual(recoverPrematureMigrationApprovalGate(store,'srpg-fixture'),[]);
  assert.equal(store.listPlanningRequests('srpg-fixture').length,1);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('unrelated human decisions are not silently bypassed while migrating',()=>{
 const {root,store,task}=fixture();
 try{
  const t=store.getTask(task.id);
  store.updateTask(t.id,t.version,{history:[{type:'ROLE_RESULT',role:'pm',outcome:'NEEDS_HUMAN',
    summary:'Decide the number of chapters',result:{startDelivery:false,questions:['Are 25 chapters required?']}}]});
  assert.deepEqual(recoverPrematureMigrationApprovalGate(store,'srpg-fixture'),[]);
  assert.equal(store.getTask(task.id).state,'NEEDS_HUMAN');
  assert.equal(store.listPlanningRequests('srpg-fixture').length,0);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
