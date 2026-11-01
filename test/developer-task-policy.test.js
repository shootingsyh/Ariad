import {legacyApplyDeliveryPlan} from './legacy-delivery-plan-fixture.js';
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
  assert.equal(developerTaskPolicyFailure({ taskKind:'MILESTONE_TASK', stage:'developer', milestoneId:'V2.1' }), null);
  assert.equal(developerTaskPolicyFailure({ taskKind:'PLANNING', stage:'developer', milestoneId:'V2.1' }), 'DEVELOPER_REQUIRES_DELIVERY_SCOPE');
  assert.equal(developerTaskPolicyFailure({ taskKind:'MILESTONE_TASK', stage:'developer', milestoneId:null }), 'DEVELOPER_REQUIRES_MILESTONE');
  assert.equal(developerTaskPolicyFailure({ taskKind:'MILESTONE_TASK', stage:'developer', milestoneId:'V2.GATE' }), 'DEVELOPER_CANNOT_EXECUTE_APPROVAL_GATE');
  assert.equal(isApprovalGateTask({milestoneId:'V2.GATE'}), true);
  assert.equal(isApprovalGateTask({taskKind:'approval_gate'}), true);
  assert.equal(developerTaskPolicyFailure({taskKind:'MILESTONE_TASK',stage:'tester',milestoneId:'V2.GATE'}),null);
});
test('delivery compiler rejects V2 approval gate rather than silently assigning developer', () => {
  const dir=mkdtempSync(join(tmpdir(),'ariad-dev-policy-'));
  const store=new SQLiteV2Store(join(dir,'state.db'));
  try{
    store.createProject({id:'P-gate'});
    assert.throws(()=>legacyApplyDeliveryPlan(store,'P-gate',{version:3,
      tasks:[{id:'v2-plan-review-gate',milestoneId:'V2.GATE',intent:'approve human review'}],
    }),/DELIVERY_PLAN_CONTROL_TASK/);
    assert.equal(store.listTasks('P-gate').length,0);
    assert.throws(()=>legacyApplyDeliveryPlan(store,'P-gate',{version:3,
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
    store.createTask({ taskKind: 'MILESTONE_TASK',id:'admin',projectId:'P-runtime',scope:'delivery',stage:'developer',milestoneId:'V2.GATE'});
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

test('issue-queue developer tasks need no milestone ownership', () => {
  assert.equal(developerTaskPolicyFailure({ taskKind: 'FEATURE_TASK', stage: 'developer', queue: 'issue', milestoneId: null }), null);
  assert.equal(developerTaskPolicyFailure({ taskKind: 'FEATURE_TASK', stage: 'developer', input: { queue: 'issue' } }), null);
  assert.equal(developerTaskPolicyFailure({ taskKind: 'FEATURE_TASK', stage: 'developer', milestoneId: null }), 'DEVELOPER_REQUIRES_MILESTONE');
});

test('scheduler drains the issue queue before milestone work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-issue-prio-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P-prio' });
    store.createTask({ taskKind: 'FEATURE_TASK', id: 'ms-task', projectId: 'P-prio', stage: 'developer', state: 'READY', milestoneId: 'M1', title: 'Milestone work' });
    store.createTask({ taskKind: 'FEATURE_TASK', id: 'ms-downstream', projectId: 'P-prio', stage: 'developer', state: 'READY', milestoneId: 'M1', title: 'Downstream', dependsOn: ['ms-task'] });
    store.createTask({ taskKind: 'FEATURE_TASK', id: 'issue-fix', projectId: 'P-prio', stage: 'developer', state: 'READY', queue: 'issue', title: 'Triaged fix' });
    const starts = [];
    const roles = new RoleRegistry();
    roles.register('developer', { prepare: () => ({ provider: 'fake' }), transition: () => ({ state: 'DONE' }) });
    const providers = new ProviderRegistry();
    providers.register({ id: 'fake', start: async (arg) => { starts.push(JSON.stringify(arg)); return { externalId: 'fake' }; }, poll: async () => ({ state: 'RUNNING' }), cancel: async () => {} });
    const scheduler = new V2Scheduler({ store, roles, providers, resources: new ResourcePool({}) });
    await scheduler.tick('P-prio');
    assert.equal(starts.length, 2);
    assert.ok(starts[0].includes('issue-fix'), `issue fix must start first, got: ${starts[0]}`);
    assert.ok(starts[1].includes('ms-task'), `milestone task must start second, got: ${starts[1]}`);
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
