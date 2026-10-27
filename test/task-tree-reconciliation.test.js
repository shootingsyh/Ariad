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
const fixtureWith=(tasks)=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-replan-'));const store=new SQLiteV2Store(join(dir,'state.db'));
 store.createProject({id:'P',mode:'NEW',deliveryEnabled:true});
 acceptInitialTaskTree(store,'P',plan(tasks));
 return {store,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
};
const fixture=()=>fixtureWith([t('a')]);
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
test('replan cannot add unfinished children under a DONE milestone',()=>{
 const f=fixture();try{
  const a=f.store.getTask('a');f.store.updateTask('a',a.version,{state:'DONE',history:[{type:'ROLE_RESULT',role:'reviewer',outcome:'PASS'}]});
  const ms=f.store.getTask('M');f.store.updateTask('M',ms.version,{state:'DONE',history:[{type:'ROLE_RESULT',role:'reviewer',outcome:'PASS'}]});
  assert.throws(()=>reconcileApprovedTaskTree(f.store,'P',plan([t('a'),t('b',['a'])])),/REVISE_COMPLETED_TASK/);
  assert.equal(f.store.getTask('b'),null);
  assert.equal(f.store.getTask('M').state,'DONE');
  assert.deepEqual(f.store.getTask('M').dependsOn,['a']);
  assert.equal(f.store.getProject('P').taskTreeVersion,1);
 }finally{f.cleanup();}
});
test('replan rejects cyclic dependencies without mutating the tree',()=>{
 const f=fixture();try{
  assert.throws(()=>reconcileApprovedTaskTree(f.store,'P',plan([t('a',['b']),t('b',['a'])])),/cycle/);
  assert.equal(f.store.getTask('b'),null);
  assert.deepEqual(f.store.getTask('a').dependsOn,[]);
  assert.equal(f.store.getProject('P').taskTreeVersion,1);
 }finally{f.cleanup();}
});
test('replan rejects dangling dependencies and keeps the referenced task',()=>{
 const f=fixtureWith([t('a'),t('b')]);try{
  // b still depends on a, but the new plan drops a: the graph validation
  // must reject the dangling reference instead of obsoleting a under b.
  assert.throws(()=>reconcileApprovedTaskTree(f.store,'P',plan([t('b',['a'])])),/depends on unknown task/);
  assert.equal(f.store.getTask('a').state,'READY');
  assert.equal(f.store.getTask('b').state,'READY');
  assert.equal(f.store.getProject('P').taskTreeVersion,1);
 }finally{f.cleanup();}
});
test('replan obsoletes a dropped WAITING_REPLAN task and recovers a kept one',()=>{
 const f=fixtureWith([t('a'),t('b')]);try{
  const st=f.store;
  for(const id of ['a','b']){const cur=st.getTask(id);st.updateTask(id,cur.version,{state:'WAITING_REPLAN',execution:null});}
  const revised={...t('b'),intent:'b-revised'};
  const result=reconcileApprovedTaskTree(st,'P',plan([revised]));
  assert.equal(result.created,0);
  const dropped=st.getTask('a');
  assert.equal(dropped.state,'OBSOLETE');
  assert.ok((dropped.history??[]).some(h=>h.type==='TASK_TREE_OBSOLETE'));
  const kept=st.getTask('b');
  assert.equal(kept.state,'READY');
  assert.equal(kept.intent,'b-revised');
  assert.equal(kept.execution,null);
  assert.ok((kept.history??[]).some(h=>h.type==='TASK_TREE_REPLANNED'&&h.previousState==='WAITING_REPLAN'));
  assert.deepEqual(st.getTask('M').dependsOn,['b']);
  assert.equal(st.getProject('P').taskTreeVersion,2);
 }finally{f.cleanup();}
});
test('replan updates parent milestone dependencies when children change',()=>{
 const f=fixture();try{
  const s=f.store;
  reconcileApprovedTaskTree(s,'P',plan([t('a'),t('c')]));
  assert.deepEqual([...s.getTask('M').dependsOn].sort(),['a','c']);
  reconcileApprovedTaskTree(s,'P',plan([t('a'),t('b',['a'])]));
  assert.deepEqual([...s.getTask('M').dependsOn].sort(),['a','b']);
  const dropped=s.getTask('c');
  assert.equal(dropped.state,'OBSOLETE');
  assert.ok((dropped.history??[]).some(h=>h.type==='TASK_TREE_OBSOLETE'));
  assert.ok(!(s.getTask('a').history??[]).some(h=>h.type==='TASK_TREE_REPLANNED'));
  assert.equal(s.getProject('P').taskTreeVersion,3);
 }finally{f.cleanup();}
});
test('replan refuses to rewrite a NEEDS_HUMAN task',()=>{
 const f=fixture();try{
  const a=f.store.getTask('a');f.store.updateTask('a',a.version,{state:'NEEDS_HUMAN',execution:null});
  const revised={...t('a'),intent:'changed while waiting for human'};
  assert.throws(()=>reconcileApprovedTaskTree(f.store,'P',plan([revised])),/REVISE_BLOCKED_TASK/);
  assert.equal(f.store.getTask('a').state,'NEEDS_HUMAN');
  assert.equal(f.store.getTask('a').intent,'a');
  assert.equal(f.store.getProject('P').taskTreeVersion,1);
 }finally{f.cleanup();}
});
test('replan rolls back every write when a mid-transaction write fails',()=>{
 const f=fixture();try{
  const s=f.store;
  let writes=0;
  const origUpdate=s.updateTask.bind(s);const origCreate=s.createTask.bind(s);
  s.updateTask=(...args)=>{writes+=1;if(writes===2) throw new Error('INJECTED_WRITE_FAILURE');return origUpdate(...args);};
  s.createTask=(...args)=>{writes+=1;if(writes===2) throw new Error('INJECTED_WRITE_FAILURE');return origCreate(...args);};
  assert.throws(()=>reconcileApprovedTaskTree(s,'P',plan([t('a'),t('b',['a'])])),/INJECTED_WRITE_FAILURE/);
  assert.equal(s.getTask('b'),null);
  assert.deepEqual(s.getTask('M').dependsOn,['a']);
  assert.equal(s.getTask('a').state,'READY');
  assert.equal(s.getProject('P').taskTreeVersion,1);
 }finally{f.cleanup();}
});
