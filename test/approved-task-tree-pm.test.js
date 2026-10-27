import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';
import {createDefaultV2Roles} from '../src/v2/default-roles.js';

test('PM PLAN_ACCEPTED persists a NEW project initial tree without legacy plan writer',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-tree-pm-'));
 const workspace=join(dir,'workspace');
 const artifactRoot=join(workspace,'.ariad','artifacts');
 const planner=join(artifactRoot,'planner');
 mkdirSync(join(planner,'logical'),{recursive:true});
 mkdirSync(join(planner,'milestones'),{recursive:true});
 const save=(path,value)=>writeFileSync(path,JSON.stringify(value));
 save(join(planner,'logical','project.json'),{id:'project',title:'Project',summary:'Task tracker',parentId:null});
 mkdirSync(join(planner,'interfaces','features'),{recursive:true});
 save(join(planner,'interfaces','features','project.json'),{
  version:1,nodeId:'project',nodeType:'feature',decomposition:{kind:'leaf',reason:'one task'},
  interfaces:[{id:'app-interface',kind:'executor',visibility:'exported',
   contract:{input:['command'],output:['result'],sideEffects:[]}}],
  imports:[],integrationScenarios:[],bindings:[],
  featureTasks:[{id:'implement',title:'Implement app',intent:'Working app',
   acceptanceCriteria:['Working app'],testStrategy:'Node tests',interfaceIds:['app-interface']}],
 });
 save(join(planner,'milestones','M1.json'),{
   id:'M1',title:'Full delivery',goal:'Working app',parentId:null,dependsOn:[],logicalRefs:['project'],
   acceptanceCriteria:['Functional app'],testStrategy:'Run app tests',
   tasks:[{id:'implement',title:'Implement app',intent:'Working app',dependsOn:[],logicalRefs:['project'],
     acceptanceCriteria:['Working app'],testStrategy:'Node tests'}],
 });
 const store=new SQLiteV2Store(join(dir,'state.db'));
 try{
  store.createProject({id:'P',mode:'NEW',deliveryEnabled:false,spec:'Build task tracker'});
  const roles=createDefaultV2Roles({store,workspace,artifactRoot,providerId:'fake',codeProviderId:'ariad-code'});
  const task={id:'pm-approval',projectId:'P',scope:'control',stage:'pm',flowId:'planner:P:1',
    input:{purpose:'PLANNER_PM_REVIEW'},history:[]};
  const result=roles.pm.transition({task,result:{outcome:'PLAN_ACCEPTED',result:{startDelivery:true,reason:'Plan validated'}}});
  assert.equal(result.state,'DONE');
  assert.equal(store.getProject('P').deliveryEnabled,true);
  assert.equal(store.getProject('P').taskTreeRootId,'M1');
  assert.equal(store.getProject('P').deliveryPlanVersion??0,0);
  const all=store.listTasks('P',{scope:'delivery'});
  assert.deepEqual(all.map(x=>x.id).sort(),['M1','implement']);
  assert.equal(store.getTask('implement').parentId,'M1');
  assert.deepEqual(store.getTask('implement').interfaceIds,['app-interface']);
  assert.deepEqual(store.getTask('M1').dependsOn,['implement']);
  assert.equal(store.getTask('M1').taskTreeSchemaVersion,1);
  assert.equal(typeof store.applyDeliveryPlan,'undefined');
  const rejectedReplan=roles.pm.transition({task,result:{outcome:'PLAN_ACCEPTED',result:{startDelivery:true}}});
  assert.equal(rejectedReplan.state,'NEEDS_HUMAN');
  assert.equal(rejectedReplan.transitionHistory.type,'TASK_TREE_REPLAN_REQUIRES_RECONCILIATION');
  assert.equal(store.listTasks('P',{scope:'delivery'}).length,2);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
