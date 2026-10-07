import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { controlTaskPolicyFailure, TASK_KINDS } from '../src/v2/control-task-policy.js';
import { piToolsForTask } from '../src/runtime/pi-runtime-config.js';
import { AriadService } from '../src/runtime/ariad-service.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { ARIAD_MODEL_ROLES } from '../src/runtime/role-models.js';

function setup(run) {
  const dir=mkdtempSync(join(tmpdir(),'ariad-adhoc-'));
  const store=new SQLiteV2Store(join(dir,'state.db'));
  try { return run(store); } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
}

test('adhoc task factory validates issuer, restricts role and preserves separate control graph',()=>{
  setup(store=>{
    store.createProject({id:'P',deliveryEnabled:false});
    assert.throws(()=>store.createAdhocAnalysis({projectId:'P',id:'x',requestedBy:'developer',instruction:'Inspect architecture'}),/UNAUTHORIZED_ISSUER/);
    assert.throws(()=>store.createAdhocAnalysis({projectId:'P',id:'x',requestedBy:'pm',instruction:''}),/REQUIRES_INSTRUCTION/);
    assert.equal(store.listTasks('P').length,0);
    const task=store.createAdhocAnalysis({projectId:'P',id:'investigate',requestedBy:'pm',instruction:'Inspect architecture'});
    assert.equal(task.scope,'control');
    assert.equal(task.stage,'tech_lead');
    assert.equal(task.taskKind,TASK_KINDS.ADHOC_ANALYSIS);
    assert.equal(task.flowId,'adhoc:P:investigate');
    assert.equal(controlTaskPolicyFailure(task),null);
    assert.throws(()=>store.createTask({
      id:'bad',projectId:'P',scope:'delivery',taskKind:TASK_KINDS.ADHOC_ANALYSIS,stage:'developer',
    }),/NON_DELIVERY_TASK_IN_DELIVERY/);
    assert.throws(()=>store.createTask({
      id:'bad2',projectId:'P',scope:'control',flowId:'adhoc:P:bad2',taskKind:TASK_KINDS.ADHOC_ANALYSIS,
      stage:'developer', input:{requestedBy:'pm',instruction:'Inspect'},
    }),/ADHOC_ANALYSIS_REQUIRES_TECH_LEAD/);
  });
});

test('scheduler dispatches authorized adhoc TL under closed Delivery, never developer task', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ariad-adhoc-'));
  const store=new SQLiteV2Store(join(dir,'state.db'));
  try {
    store.createProject({id:'P',deliveryEnabled:false,deliveryPlanVersion:3});
    store.createAdhocAnalysis({projectId:'P',id:'diagnose',requestedBy:'operator',instruction:'Investigate'});
    store.createTask({id:'D',projectId:'P',scope:'delivery',stage:'developer',milestoneId:'V2.1'});
    const called=[];
    const roles=new RoleRegistry();
    roles.register('tech_lead',{prepare:()=>({provider:'fake'}),transition:()=>({state:'DONE'})});
    roles.register('developer',{prepare:()=>({provider:'fake'}),transition:()=>({state:'DONE'})});
    const providers=new ProviderRegistry();
    providers.register({id:'fake',start:async(spec)=>{called.push(spec);return {externalId:'ex'};},poll:async()=>({state:'RUNNING'}),cancel:async()=>{}});
    const scheduler=new V2Scheduler({store,roles,providers,resources:new ResourcePool({})});
    const result=await scheduler.tick('P');
    assert.equal(result.started.length,1);
    assert.equal(store.getTask('adhoc:P:diagnose:analysis').state,'WORKING');
    assert.equal(store.getTask('D').state,'READY');
    assert.equal(called.length,1);
    assert.equal(called[0].taskKind, TASK_KINDS.ADHOC_ANALYSIS);
    assert.equal(called[0].role, 'tech_lead');
    assert.equal(piToolsForTask(called[0]).includes('bash'), false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});


test('STOPPED scheduling dispatches only ad-hoc TL; planning and delivery remain untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-stopped-lane-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', deliveryEnabled: true, deliveryPlanVersion: 3 });
    store.createAdhocAnalysis({ projectId: 'P', id: 'inspect', requestedBy: 'operator', instruction: 'Inspect' });
    store.createTask({ id: 'D', projectId: 'P', scope: 'delivery', stage: 'developer', milestoneId: 'M1' });
    store.createTask({ id: 'C', projectId: 'P', scope: 'control',
      flowId: 'planner:P:unrelated', stage: 'tech_lead', state: 'READY' });
    store.enqueuePlanningRequest({ id: 'new-plan', projectId: 'P', request: { purpose: 'PLANNER_DECOMPOSE' } });
    const calls = [];
    const roles = new RoleRegistry();
    roles.register('tech_lead', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => ({ state: 'DONE' }),
    });
    roles.register('developer', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => ({ state: 'DONE' }),
    });
    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake',
      start: async spec => { calls.push(spec); return { externalId: 'run' }; },
      poll: async () => ({ state: 'RUNNING' }),
      cancel: async () => {},
    });
    const scheduler = new V2Scheduler({ store, roles, providers, resources: new ResourcePool({}) });
    const result = await scheduler.tick('P', { adhocOnly: true });
    assert.deepEqual(result.started, ['adhoc:P:inspect:analysis']);
    assert.equal(calls[0].role, 'tech_lead');
    assert.equal(store.getTask('D').state, 'READY');
    assert.equal(store.getTask('C').state, 'READY');
    assert.equal(store.listPlanningRequests('P', { states: ['PENDING'] }).length, 1);
    assert.equal(store.getProject('P').deliveryEnabled, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('STOPPED service reconciles independent analysis without changing lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-stopped-service-'));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const project = manager.create('stopped-probe', { goal: 'Probe STOPPED lane',
    roleModels: Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'test/runtime'])),
  });
  const store = new SQLiteV2Store(project.stateDb);
  store.createProject({ id: project.id, workspace: project.workspace, deliveryEnabled: false });
  store.createAdhocAnalysis({ projectId: project.id, id: 'probe', requestedBy: 'operator', instruction: 'Review' });
  const calls = [];
  const fakeRuntime = {
    store,
    tick: async opts => { calls.push(opts); },
    close: () => { calls.push('closed'); },
  };
  const service = new AriadService({
    manager,
    provider: { id: 'fake', close: async () => {} },
    memoryCurator: { close: async () => {} },
  });
  service.runtimeFor = () => fakeRuntime;
  try {
    const before = manager.status(project.id);
    assert.equal(before.desiredState, 'STOPPED');
    await service.reconcileProject(before);
    assert.deepEqual(calls, [{ adhocOnly: true }]);
    assert.equal(manager.status(project.id).desiredState, 'STOPPED');
    assert.equal(manager.status(project.id).executionState, before.executionState);
  } finally {
    await service.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
