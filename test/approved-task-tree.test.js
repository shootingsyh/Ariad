import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';
import {acceptInitialTaskTree} from '../src/v2/approved-task-tree.js';
import {buildExecutionGraph} from '../src/v2/execution-graph.js';

test('approved planner nodes persist as one direct hierarchy with parent acceptance after children',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-approved-tree-'));
 const store=new SQLiteV2Store(join(dir,'db.sqlite'));
 try {
  store.createProject({id:'p',mode:'NEW',deliveryEnabled:false});
  const m=(id,parentId,dependsOn=[])=>({id,parentId,dependsOn,title:id,goal:id,acceptanceCriteria:['Acceptance'],logicalRefs:['root'],testStrategy:'test'});
  const t=(id,milestoneId,dependsOn=[])=>({id,milestoneId,dependsOn,title:id,intent:id,acceptanceCriteria:['Acceptance'],logicalRefs:['root'],testStrategy:'test'});
  const plan={version:3,logicalNodes:[{id:'root',parentId:null}],milestones:[m('root',null),m('core','root'),m('view','root')],tasks:[t('core-code','core'),t('view-code','view',['core-code'])]};
  assert.equal(acceptInitialTaskTree(store,'p',plan),5);
  const rows=store.listTasks('p',{scope:'delivery'});
  assert.equal(rows.length,5);
  assert.equal(rows.find(t=>t.id==='core-code').parentId,'core');
  assert.equal(rows.find(t=>t.id==='core').parentId,'root');
  assert.deepEqual(rows.find(t=>t.id==='root').dependsOn.sort(),['core','view']);
  assert.deepEqual(rows.find(t=>t.id==='view').dependsOn,['view-code']);
  assert.equal(store.getProject('p').deliveryEnabled,false);
  assert.equal(store.getProject('p').taskTreeRootId,'root');
  const graph=buildExecutionGraph(rows);
  assert.equal(graph.isRunnable(graph.byId.get('root')),false);
  assert.equal(graph.isRunnable(graph.byId.get('core-code')),true);
  assert.throws(()=>acceptInitialTaskTree(store,'p',plan),/EXISTING_TASKS/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('approved tree validation rejects cycles atomically without partial task rows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-approved-invalid-'));
 const store=new SQLiteV2Store(join(dir,'db.sqlite'));
 try {
  store.createProject({id:'p',mode:'NEW',deliveryEnabled:false});
  const m={id:'root',parentId:null,dependsOn:[],title:'root',goal:'root',acceptanceCriteria:['AC'],logicalRefs:['root'],testStrategy:'test'};
  const plan={version:3,milestones:[m],tasks:[{id:'one',milestoneId:'root',dependsOn:['root'],intent:'one',acceptanceCriteria:['AC'],logicalRefs:['root'],testStrategy:'test'}]};
  assert.throws(()=>acceptInitialTaskTree(store,'p',plan),/cycle/);
  assert.deepEqual(store.listTasks('p',{scope:'delivery'}),[]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
