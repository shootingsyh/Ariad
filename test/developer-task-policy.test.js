import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { developerTaskPolicyFailure, isApprovalGateTask } from '../src/v2/developer-task-policy.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';

test('developer requires actual milestone delivery work; milestone-labelled approval gates never qualify', () => {
  assert.equal(developerTaskPolicyFailure({ scope:'delivery', stage:'developer', milestoneId:'V2.1' }), null);
  assert.equal(developerTaskPolicyFailure({ scope:'control', stage:'developer', milestoneId:'V2.1' }), 'DEVELOPER_REQUIRES_DELIVERY_SCOPE');
  assert.equal(developerTaskPolicyFailure({ scope:'delivery', stage:'developer', milestoneId:null }), 'DEVELOPER_REQUIRES_MILESTONE');
  assert.equal(developerTaskPolicyFailure({ scope:'delivery', stage:'developer', milestoneId:'V2.GATE' }), 'DEVELOPER_CANNOT_EXECUTE_APPROVAL_GATE');
  assert.equal(isApprovalGateTask({milestoneId:'V2.GATE'}), true);
  assert.equal(isApprovalGateTask({taskKind:'approval_gate'}), true);
  assert.equal(developerTaskPolicyFailure({scope:'delivery',stage:'tester',milestoneId:'V2.GATE'}),null);
});
test('delivery compiler rejects V2 approval gate rather than silently assigning developer', () => {
  const dir=mkdtempSync(join(tmpdir(),'ariad-dev-policy-'));
  const store=new SQLiteV2Store(join(dir,'state.db'));
  try{
    store.createProject({id:'P-gate'});
    assert.throws(()=>store.applyDeliveryPlan('P-gate',{version:3,
      tasks:[{id:'v2-plan-review-gate',milestoneId:'V2.GATE',intent:'approve human review'}],
    }),/DELIVERY_PLAN_CONTROL_TASK/);
    assert.equal(store.listTasks('P-gate').length,0);
    assert.throws(()=>store.applyDeliveryPlan('P-gate',{version:3,
      tasks:[{id:'adhoc-cleanup',intent:'adhoc action'}],
    }),/DEVELOPER_REQUIRES_MILESTONE/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('scheduler fails closed without starting approval gate or ad-hoc developer work',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ariad-dev-policy-'));
  const store=new SQLiteV2Store(join(dir,'state.db'));
  let calls=0;
  try{
    store.createProject({id:'P-runtime',deliveryEnabled:true,deliveryPlanVersion:1});
    store.createTask({id:'admin',projectId:'P-runtime',scope:'delivery',stage:'developer',milestoneId:'V2.GATE'});
    const roles=new RoleRegistry();
    roles.register('developer',{prepare:()=>({provider:'fake'}),transition:()=>({state:'DONE'})});
    const providers=new ProviderRegistry();
    providers.register({id:'fake',start:async()=>{calls++;return{externalId:'fake'};},poll:async()=>({state:'RUNNING'}),cancel:async()=>{}});
    const scheduler=new V2Scheduler({store,roles,providers,resources:new ResourcePool({})});
    await assert.rejects(()=>scheduler.tick('P-runtime'),/DEVELOPER_CANNOT_EXECUTE_APPROVAL_GATE/);
    assert.equal(calls,0);
    assert.equal(store.getTask('admin').state,'READY');
    store.updateTask('admin',store.getTask('admin').version,{milestoneId:null});
    await assert.rejects(()=>scheduler.tick('P-runtime'),/DEVELOPER_REQUIRES_MILESTONE/);
    assert.equal(calls,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
