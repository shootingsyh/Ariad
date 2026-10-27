import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';
import {acceptInitialTaskTree} from '../src/v2/approved-task-tree.js';
import {reconcileApprovedTaskTree} from '../src/v2/task-tree-reconciliation.js';

const m={id:'M',title:'Milestone',goal:'Deliver',parentId:null,dependsOn:[],logicalRefs:['root'],acceptanceCriteria:['M passes'],testStrategy:'test'};
const t=(id,dependsOn=[])=>({id,title:id,intent:id,dependsOn,logicalRefs:['root'],milestoneId:'M',acceptanceCriteria:['AC1'],testStrategy:'test'});
const plan=(tasks)=>({version:3,milestones:[{...m,tasks}],tasks,logicalNodes:[{id:'root',parentId:null}]});
const fixture=()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-replan-'));const store=new SQLiteV2Store(join(dir,'state.db'));
 store.createProject({id:'P',mode:'NEW',deliveryEnabled:true});
 acceptInitialTaskTree(store,'P',plan([t('a')]));
 return {store,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
};
test('replan adds approved tasks and preserves completed child history',()=>{
 const f=fixture();try{
  let child=f.store.getTask('a');
  f.store.updateTask('a',child.version,{state:'DONE',stage:'reviewer',history:[{type:'ROLE_RESULT',role:'reviewer',outcome:'PASS'}]});
  const result=reconcileApprovedTaskTree(f.store,'P',plan([t('a'),t('b',['a'])]));
  assert.equal(result.created,1);
  assert.equal(f.store.getTask('a').state,'DONE');
  assert.deepEqual(f.store.getTask('a').history,[{type:'ROLE_RESULT',role:'reviewer',outcome:'PASS'}]);
  assert.deepEqual(f.store.getTask('b').dependsOn,['a']);
  assert.equal(f.store.getTask('M').state,'READY');
  assert.equal(f.store.getProject('P').taskTreeVersion,2);
 }finally{f.cleanup();}
});
test('replan refuses active roles and does not mutate DB',()=>{
 const f=fixture();try{
  const c=f.store.getTask('a');f.store.updateTask('a',c.version,{state:'WORKING',execution:{id:'live'}});
  const before=f.store.getProject('P').taskTreeVersion;
  assert.throws(()=>reconcileApprovedTaskTree(f.store,'P',plan([t('a'),t('b')])),/ACTIVE_EXECUTION/);
  assert.equal(f.store.getTask('b'),null);
  assert.equal(f.store.getProject('P').taskTreeVersion,before);
 }finally{f.cleanup();}
});
test('replan rejects changes to completed acceptance and preserves original',()=>{
 const f=fixture();try{
  const old=f.store.getTask('a');f.store.updateTask('a',old.version,{state:'DONE',history:[{type:'ROLE_RESULT',role:'reviewer',outcome:'PASS'}]});
  const revised={...t('a'),intent:'different semantics'};
  assert.throws(()=>reconcileApprovedTaskTree(f.store,'P',plan([revised])),/REVISE_COMPLETED_TASK/);
  assert.equal(f.store.getTask('a').intent,'a');
  assert.equal(f.store.getProject('P').taskTreeVersion,1);
 }finally{f.cleanup();}
});
