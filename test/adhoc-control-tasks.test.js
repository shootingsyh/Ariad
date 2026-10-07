import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
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


test('offline E2E: STOPPED project completes ad-hoc TL with durable result, no delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-stopped-e2e-'));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const project = manager.create('isolated-e2e', {
    goal: 'Verify isolated offline ad-hoc execution',
    roleModels: Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'test/runtime'])),
  });
  const started = [];
  const provider = {
    id: 'fake',
    start: async spec => { started.push(spec); return { externalId: 'fake-run' }; },
    poll: async () => ({
      state: 'COMPLETED',
      outcome: 'PLANNED',
      summary: 'Scratch workspace has no product code',
      keyPoints: ['Inspected the scratch workspace'],
      artifacts: [],
    }),
    cancel: async () => {},
    close: async () => {},
  };
  const service = new AriadService({
    manager, provider, memoryCurator: { close: async () => {} },
  });
  try {
    const created = service.createOperatorAnalysis(project.id, {
      id: 'offline-e2e',
      instruction: 'Inspect scratch workspace and report findings',
    });
    const db = new SQLiteV2Store(project.stateDb);
    try {
      db.createTask({ id: 'D-untouched', projectId: project.id, scope: 'delivery',
        stage: 'developer', milestoneId: 'M1' });
    } finally { db.close(); }
    for (let i = 0; i < 4; i++) await service.reconcileProject(manager.status(project.id));
    const store = new SQLiteV2Store(project.stateDb);
    try {
      const task = store.getTask(created.taskId);
      assert.equal(task.state, 'DONE');
      assert.equal(task.stage, 'tech_lead');
      assert.equal(task.taskKind, 'ADHOC_ANALYSIS');
      assert.ok(task.history.some(h => h.type === 'ROLE_RESULT'
        && h.summary === 'Scratch workspace has no product code'));
      assert.equal(store.getTask('D-untouched').state, 'READY');
      assert.equal(store.getProject(project.id).deliveryEnabled, false);
      assert.equal(store.listPlanningRequests(project.id).length, 0);
      assert.equal(started.length, 1);
      assert.equal(started[0].taskKind, 'ADHOC_ANALYSIS');
      assert.equal(started[0].context.sessionKey, 'adhoc:' + project.id + ':' + created.taskId);
      assert.equal(piToolsForTask(started[0]).includes('write'), false);
      assert.equal(manager.status(project.id).desiredState, 'STOPPED');
    } finally { store.close(); }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});


test('idle STOPPED project is not initialized by the background reconcile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-stopped-noop-'));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const project = manager.create('idle-probe', {
    goal: 'No unrequested work',
    roleModels: Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'test/runtime'])),
  });
  const store = new SQLiteV2Store(project.stateDb);
  store.createProject({ id: project.id, workspace: project.workspace, deliveryEnabled: false });
  store.close();
  const service = new AriadService({
    manager, provider: { id: 'fake' },
    memoryCurator: { close: async () => {} },
  });
  service.runtimeFor = () => { throw new Error('STOPPED_RUNTIME_MUST_NOT_START'); };
  try {
    await service.reconcileProject(manager.status(project.id));
    assert.equal(manager.status(project.id).desiredState, 'STOPPED');
    assert.equal(service.runtimes.size, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});


test('negative task kind, role, scope and issuer combinations fail closed', () => {
  setup(store => {
    store.createProject({ id: 'POLICY', deliveryEnabled: true });
    const invalid = [
      [{ scope: 'control', flowId: 'adhoc:POLICY:wrong', stage: 'developer',
         taskKind: 'ADHOC_ANALYSIS', input: { requestedBy: 'operator', instruction: 'Inspect' } },
       /ADHOC_ANALYSIS_REQUIRES_TECH_LEAD/],
      [{ scope: 'control', flowId: 'planner:POLICY:bad', stage: 'tech_lead',
         taskKind: 'ADHOC_ANALYSIS', input: { requestedBy: 'operator', instruction: 'Inspect' } },
       /ADHOC_ANALYSIS_REQUIRES_ADHOC_FLOW/],
      [{ scope: 'control', flowId: 'adhoc:POLICY:bad', stage: 'tech_lead',
         taskKind: 'ADHOC_ANALYSIS', input: { requestedBy: 'developer', instruction: 'Inspect' } },
       /ADHOC_ANALYSIS_UNAUTHORIZED_ISSUER/],
      [{ scope: 'control', flowId: 'adhoc:POLICY:bad', stage: 'tech_lead',
         taskKind: 'ADHOC_ANALYSIS', input: { requestedBy: 'operator', instruction: ' ' } },
       /ADHOC_ANALYSIS_REQUIRES_INSTRUCTION/],
      [{ scope: 'delivery', stage: 'tech_lead', taskKind: 'ADHOC_ANALYSIS' },
       /NON_DELIVERY_TASK_IN_DELIVERY/],
      [{ scope: 'control', flowId: 'adhoc:POLICY:bad', stage: 'developer',
         taskKind: 'MILESTONE_TASK' }, /MILESTONE_TASK_REQUIRES_DELIVERY/],
      [{ scope: 'control', flowId: 'planner:POLICY:bad', stage: 'developer',
         taskKind: 'PLANNING' }, /CONTROL_TASK_INVALID_ROLE/],
      [{ scope: 'control', flowId: 'adhoc:POLICY:bad', stage: 'tech_lead',
         taskKind: 'PLANNING' }, /PLANNING_REQUIRES_PLANNER_FLOW/],
      [{ scope: 'control', flowId: 'planner:POLICY:bad', stage: 'tech_lead',
         taskKind: 'REVIEW_GATE' }, /REVIEW_GATE_REQUIRES_PM/],
      [{ scope: 'control', flowId: 'planner:POLICY:bad', stage: 'pm',
         taskKind: 'DIAGNOSTIC' }, /DIAGNOSTIC_REQUIRES_DEBUGGER/],
      [{ scope: 'control', flowId: 'planner:POLICY:bad', stage: 'tech_lead',
         taskKind: 'MALICIOUS_UNKNOWN' }, /UNKNOWN_TASK_KIND/],
      [{ scope: 'unrecognized', stage: 'developer', taskKind: 'MILESTONE_TASK' },
       /invalid task scope/],
    ];
    for (const [i, [task, failure]] of invalid.entries()) {
      assert.throws(() => store.createTask({ id: 'bad-' + i,
        projectId: 'POLICY', ...task }), failure);
    }
    assert.equal(store.listTasks('POLICY').length, 0, 'failed admissions must leave no tasks');
    const valid = store.createAdhocAnalysis({
      projectId: 'POLICY', id: 'valid', requestedBy: 'operator', instruction: 'Inspect',
    });
    assert.throws(() => store.updateTask(valid.id, valid.version, {
      stage: 'developer',
    }), /ADHOC_ANALYSIS_REQUIRES_TECH_LEAD/, 'updates must enforce the policy as well');
    assert.equal(store.getTask(valid.id).stage, 'tech_lead');
  });
});

test('STOPPED scheduler cannot advance unrelated results or dispatch developer even with open delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-adhoc-neg-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  let launches = 0;
  try {
    store.createProject({ id: 'NEG', deliveryEnabled: true, deliveryPlanVersion: 3 });
    store.createTask({ id: 'developer-ready', projectId: 'NEG', scope: 'delivery',
      stage: 'developer', milestoneId: 'M1' });
    store.createTask({ id: 'delivery-result', projectId: 'NEG', scope: 'delivery',
      stage: 'tester', milestoneId: 'M1', state: 'RESULT_READY',
      history: [{ type: 'ROLE_RESULT', role: 'tester', outcome: 'PASS' }] });
    const roles = new RoleRegistry();
    roles.register('developer', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => { throw new Error('ILLEGAL_DEVELOPER_ADVANCE'); },
    });
    roles.register('tester', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => { throw new Error('ILLEGAL_RESULT_ADVANCE'); },
    });
    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake', start: async () => { launches++; return { externalId: 'x' }; },
      poll: async () => ({ state: 'RUNNING' }), cancel: async () => {},
    });
    const scheduler = new V2Scheduler({ store, roles, providers, resources: new ResourcePool({}) });
    assert.deepEqual((await scheduler.tick('NEG', { adhocOnly: true })).started, []);
    assert.equal(launches, 0);
    assert.equal(store.getTask('developer-ready').state, 'READY');
    assert.equal(store.getTask('delivery-result').state, 'RESULT_READY');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('restart recovery audits only stopped ad-hoc tasks, without touching suspended delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-adhoc-restart-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'R', deliveryEnabled: true, deliveryPlanVersion: 2 });
    const analysis = store.createAdhocAnalysis({
      projectId: 'R', id: 'restart', requestedBy: 'operator', instruction: 'Review state',
    });
    const working = {
      provider: 'fake', externalId: 'missing-session',
      attemptId: 'attempt-old', resources: [], role: 'developer',
    };
    store.createTask({
      id: 'suspended-dev', projectId: 'R', scope: 'delivery',
      stage: 'developer', milestoneId: 'M1', state: 'WORKING',
      execution: working,
    });
    const roles = new RoleRegistry();
    roles.register('tech_lead', {
      prepare: () => ({ provider: 'fake' }),
      transition: () => ({ state: 'DONE' }),
    });
    const providers = new ProviderRegistry();
    providers.register({
      id: 'fake', start: async () => ({ externalId: 'missing-session' }),
      poll: async () => ({ state: 'LOST', failure: 'SESSION_GONE', restartOrphan: true, consumeAttempt: false }),
      cancel: async () => {},
    });
    const resources = new ResourcePool({});
    const scheduler = new V2Scheduler({ store, roles, providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });
    await scheduler.tick('R', { adhocOnly: true });
    assert.equal(store.getTask(analysis.id).state, 'WORKING');
    const result = await supervisor.audit('R', { adhocOnly: true });
    assert.equal(result.incidents.length, 1);
    assert.equal(store.getTask(analysis.id).state, 'READY');
    assert.equal(store.getTask(analysis.id).history.at(-1).consumeAttempt, false);
    assert.equal(store.getTask('suspended-dev').state, 'WORKING');
    assert.equal(store.getTask('suspended-dev').history.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
