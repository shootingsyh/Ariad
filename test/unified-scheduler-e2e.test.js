import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';
import {V2Scheduler} from '../src/v2/scheduler.js';
import {V2Supervisor} from '../src/v2/supervisor.js';
import {RoleRegistry} from '../src/v2/role-registry.js';
import {ProviderRegistry} from '../src/v2/provider-registry.js';
import {ResourcePool} from '../src/v2/resource-pool.js';

// All provider interactions are fake; this suite cannot run SRPG or real models.
test('unified scheduler gates aggregate children and completes dev-test-review without legacy recompilation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-unified-scheduler-'));
 const store=new SQLiteV2Store(join(dir,'state.db'));
 try {
  store.createProject({id:'p',spec:'fixture',deliveryEnabled:true,unifiedTaskCompilerVersion:1,deliveryPlanVersion:3});
  const mk=(id,mode,deps,parent=null)=>({id,projectId:'p',scope:'delivery',stage:'developer',state:'READY',milestoneId:'A',parentId:parent,executionMode:mode,unifiedTaskSchemaVersion:1,dependsOn:deps,interfaceIds:['iface'],input:{interfaceIds:['iface'],milestoneId:'A'},history:[]});
  store.createTask(mk('A','aggregate',['leaf']));
  store.createTask(mk('leaf','implementation',[],'A'));
  const roles=new RoleRegistry();
  for(const role of ['developer','test_engineer','tester','reviewer'])roles.register(role,{
   prepare:()=>({provider:'fake',resources:['gpu']}),
   transition:()=>{throw new Error('legacy role transition invoked');},
  });
  let counter=0;
  const statuses=new Map();const starts=[];
  const provider={id:'fake',async start(spec){const externalId=`f-${++counter}`;starts.push({id:spec.taskId,role:spec.role});statuses.set(externalId,{state:'RUNNING'});return {externalId};},async poll({externalId}){return statuses.get(externalId);},async cancel(){}};
  const providers=new ProviderRegistry();providers.register(provider);
  const resources=new ResourcePool({gpu:1});
  const scheduler=new V2Scheduler({store,roles,providers,resources});
  const supervisor=new V2Supervisor({store,providers,resources});
  assert.equal(typeof store.applyDeliveryPlan,'undefined');
  for(const id of ['leaf','A']) {
   for(const role of ['developer','test_engineer','tester','reviewer']) {
    if(store.getTask(id).state!=='WORKING') await scheduler.tick('p');
    const task=store.getTask(id);
    assert.equal(task.stage,role);
    assert.equal(task.state,'WORKING');
    if(id==='leaf')assert.equal(store.getTask('A').state,'READY');
    statuses.set(task.execution.externalId,{state:'COMPLETED',outcome:'PASS',result:role==='test_engineer'?{testPlan:{testCases:[{entry:'src/index.js',command:'node --check src/index.js',covers:[],executionScope:['src/index.js']}]}}:{}});
    await supervisor.audit('p');
    assert.equal(store.getTask(id).state,'RESULT_READY');
   }
   await scheduler.tick('p');
   assert.equal(store.getTask(id).state,'DONE');
  }
  assert.deepEqual(starts.map(x=>`${x.id}:${x.role}`),['leaf:developer','leaf:test_engineer','leaf:tester','leaf:reviewer','A:developer','A:test_engineer','A:tester','A:reviewer']);
  assert.equal(store.getTask('A').history.filter(h=>h.type==='ROLE_RESULT').length,4);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('unified scheduler never dispatches delivery while locked',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-unified-locked-'));
 const store=new SQLiteV2Store(join(dir,'state.db'));
 try {
  store.createProject({id:'locked',deliveryEnabled:false,unifiedTaskCompilerVersion:1});
  store.createTask({id:'A',projectId:'locked',scope:'delivery',stage:'developer',state:'READY',milestoneId:'A',executionMode:'aggregate',unifiedTaskSchemaVersion:1,dependsOn:[]});
  const roles=new RoleRegistry();roles.register('developer',{prepare:()=>({provider:'fake'}),transition:()=>({state:'DONE'})});
  const providers=new ProviderRegistry();let calls=0;
  providers.register({id:'fake',async start(){calls++;return {externalId:'x'};},async poll(){return {state:'RUNNING'};},async cancel(){}});
  const scheduler=new V2Scheduler({store,roles,providers,resources:new ResourcePool({})});
  assert.deepEqual((await scheduler.tick('locked')).started,[]);
  assert.equal(calls,0);
  assert.equal(store.getTask('A').state,'READY');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('task tracker direct task tree runs dependency-first through milestone executor without compiling a delivery plan',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-task-tracker-tree-'));
 const store=new SQLiteV2Store(join(dir,'state.db'));
 try{
  store.createProject({id:'tracker',spec:'Task Tracker',deliveryEnabled:true});
  const tasks=[
   {id:'core',dependsOn:[],parentId:'tracker-root'},
   {id:'view',dependsOn:[],parentId:'tracker-root'},
   {id:'integration',dependsOn:['core','view'],parentId:'tracker-root'},
   {id:'tracker-root',dependsOn:['integration'],parentId:null},
  ];
  for(const t of tasks)store.createTask({...t,projectId:'tracker',scope:'delivery',stage:'developer',state:'READY',taskKind:'MILESTONE_TASK',milestoneId:'tracker-root',input:{intent:t.id,acceptanceCriteria:[]}});
  const roles=new RoleRegistry();
  for(const role of ['developer','test_engineer','tester','reviewer'])roles.register(role,{
   prepare:()=>({provider:'fake'}),transition:()=>{throw Error('legacy role transition must not run');},
  });
  const statuses=new Map(),started=[];
  let sequence=0;
  const providers=new ProviderRegistry();
  providers.register({id:'fake',async start(spec){
   const externalId='run-'+(++sequence);
   started.push(spec.taskId+':'+spec.role);
   statuses.set(externalId,{state:'RUNNING'});
   return {externalId};
  },async poll({externalId}){return statuses.get(externalId);},async cancel(){}});
  const resources=new ResourcePool({});
  const scheduler=new V2Scheduler({store,roles,providers,resources});
  const supervisor=new V2Supervisor({store,providers,resources});
  for(let i=0;i<60;i++){
   await scheduler.tick('tracker');
   for(const task of store.listTasks('tracker').filter(t=>t.state==='WORKING')){
    statuses.set(task.execution.externalId,{state:'COMPLETED',outcome:'PASS',result:task.stage==='test_engineer'?{
     testPlan:{testCases:[{entry:'test/task-tracker.test.js',command:'node --test test/task-tracker.test.js',covers:[],executionScope:['test/task-tracker.test.js']}]}
    }:{}});
   }
   await supervisor.audit('tracker');
   if(store.listTasks('tracker').every(t=>t.state==='DONE'))break;
  }
  assert.ok(store.listTasks('tracker').every(t=>t.state==='DONE'));
  for(const id of ['core','view','integration','tracker-root']){
   assert.deepEqual(started.filter(x=>x.startsWith(id+':')).map(x=>x.split(':')[1]),['developer','test_engineer','tester','reviewer']);
  }
  const firstIntegration=started.findIndex(x=>x.startsWith('integration:'));
  assert.ok(firstIntegration>started.findIndex(x=>x==='core:reviewer'));
  assert.ok(firstIntegration>started.findIndex(x=>x==='view:reviewer'));
  assert.ok(started.findIndex(x=>x.startsWith('tracker-root:'))>started.findIndex(x=>x==='integration:reviewer'));
  assert.equal(store.getProject('tracker').deliveryPlanVersion??0,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
