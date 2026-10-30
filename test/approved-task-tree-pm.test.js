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
  const task={id:'pm-approval',projectId:'P',taskKind:'PLANNING',stage:'pm',flowId:'planner:P:1',
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
  const unchangedReplan=roles.pm.transition({task,result:{outcome:'PLAN_ACCEPTED',result:{startDelivery:true}}});
  assert.equal(unchangedReplan.state,'DONE');
  assert.equal(store.getProject('P').taskTreeVersion,2);
  assert.equal(store.listTasks('P',{scope:'delivery'}).length,2);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

import { compileUnifiedTaskTree } from '../src/v2/unified-task-compiler.js';

function unifiedFixture(dir, { withFix = false, implementIntent = 'Working app', implementDependsOnFix = false } = {}) {
  const workspace = join(dir, 'workspace');
  const artifactRoot = join(workspace, '.ariad', 'artifacts');
  const planner = join(artifactRoot, 'planner');
  const save = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  save(join(planner, 'logical', 'project.json'), { id: 'project', title: 'Project', summary: 'Task tracker', parentId: null });
  const featureTasks = [{ id: 'implement', title: 'Implement app', intent: implementIntent,
    acceptanceCriteria: ['Working app'], testStrategy: 'Node tests', interfaceIds: [] }];
  if (withFix) featureTasks.push({ id: 'fix-logs', title: 'Fix retained logs', intent: 'Stop excluding retained evidence logs',
    acceptanceCriteria: ['Logs retained'], testStrategy: 'Node tests', interfaceIds: [], issueRefs: ['issue:fix-logs'] });
  save(join(planner, 'interfaces', 'features', 'project.json'), {
    version: 1, nodeId: 'project', nodeType: 'feature', decomposition: { kind: 'leaf', reason: 'bounded' },
    interfaces: [], imports: [], integrationScenarios: [], bindings: [], featureUses: [],
    featureTasks, taskLinks: [], integrationTasks: [],
  });
  const docEntries = [
    { id: 'm1-e2e', title: 'M1 integration', intent: 'Prove delivery', dependsOn: [], logicalRefs: ['project'], acceptanceCriteria: ['Proven'], testStrategy: 'E2E' },
    { id: 'implement', title: 'Implement app', intent: 'Working app', dependsOn: [], logicalRefs: ['project'], acceptanceCriteria: ['Working app'], testStrategy: 'Node tests' },
  ];
  if (withFix) docEntries.push({ id: 'fix-logs', title: 'Fix retained logs', intent: 'Stop excluding retained evidence logs', dependsOn: [], logicalRefs: ['project'], acceptanceCriteria: ['Logs retained'], testStrategy: 'Node tests' });
  save(join(planner, 'milestones', 'M1.json'), {
    id: 'M1', title: 'Full delivery', goal: 'Working app', parentId: null, dependsOn: [], logicalRefs: ['project'],
    acceptanceCriteria: ['Functional app'], testStrategy: 'Run app tests', tasks: docEntries,
  });
  const taskLinks = [{ taskId: 'implement', addDependsOn: implementDependsOnFix ? ['fix-logs'] : [], addVerification: [] }];
  if (withFix) taskLinks.push({ taskId: 'fix-logs', addDependsOn: [], addVerification: [] });
  save(join(planner, 'interfaces', 'milestones', 'M1.json'), {
    version: 1, nodeId: 'M1', nodeType: 'milestone', decomposition: { kind: 'leaf', reason: 'bounded' },
    interfaces: [], imports: [], integrationScenarios: [], bindings: [], featureUses: [], featureTasks: [],
    integrationTasks: [{ id: 'm1-e2e', title: 'M1 integration', intent: 'Prove delivery',
      acceptanceCriteria: ['Proven'], testStrategy: 'E2E', verification: [] }],
    taskLinks,
  });
  return { workspace, artifactRoot };
}

function seedUnified(store, artifactRoot) {
  store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: true, unifiedTaskCompilerVersion: 1, spec: 'Build task tracker' });
  for (const spec of compileUnifiedTaskTree(artifactRoot).tasks) {
    store.createTask({ ...spec, projectId: 'P', state: 'READY', stage: 'developer' });
  }
}

const pmTask = (id) => ({ id, projectId: 'P', taskKind: 'PLANNING', stage: 'pm',
  flowId: 'planner:P:batch', input: { purpose: 'PLANNER_PM_REVIEW' }, history: [] });
const accept = { outcome: 'PLAN_ACCEPTED', result: { startDelivery: false, reason: 'Plan validated' } };

test('PM PLAN_ACCEPTED on a unified project lands new approved tasks in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-tree-pm-unified-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    const { workspace, artifactRoot } = unifiedFixture(dir);
    seedUnified(store, artifactRoot);
    const roles = createDefaultV2Roles({ store, workspace, artifactRoot, providerId: 'fake', codeProviderId: 'ariad-code' });
    const first = roles.pm.transition({ task: pmTask('pm-1'), result: accept });
    assert.equal(first.state, 'DONE');
    assert.match(first.transitionHistory.summary, /without rewriting/);
    unifiedFixture(dir, { withFix: true });
    const second = roles.pm.transition({ task: pmTask('pm-2'), result: accept });
    assert.equal(second.state, 'DONE');
    assert.deepEqual(second.transitionHistory.landed.created, ['fix-logs']);
    const fix = store.getTask('fix-logs');
    assert.equal(fix.state, 'READY');
    assert.equal(fix.unifiedTaskSchemaVersion, 1);
    assert.deepEqual(fix.issueRefs, ['issue:fix-logs']);
    assert.ok(store.getTask('M1').dependsOn.includes('fix-logs'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('PM PLAN_ACCEPTED on a unified project blocks when the plan would revise DONE work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-tree-pm-unified-blocked-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    const { workspace, artifactRoot } = unifiedFixture(dir);
    seedUnified(store, artifactRoot);
    const done = store.getTask('implement');
    store.updateTask('implement', done.version, { state: 'DONE' });
    unifiedFixture(dir, { withFix: true, implementDependsOnFix: true });
    const roles = createDefaultV2Roles({ store, workspace, artifactRoot, providerId: 'fake', codeProviderId: 'ariad-code' });
    const result = roles.pm.transition({ task: pmTask('pm-3'), result: accept });
    // The gate ladder intercepts the block: the plan goes back to the tech
    // lead with the failure detail instead of landing or parking silently.
    assert.equal(result.state, 'READY');
    assert.equal(result.stage, 'tech_lead');
    assert.equal(result.transitionHistory.type, 'PLAN_GATE_RETRY');
    assert.equal(result.transitionHistory.blockedType, 'UNIFIED_TASK_TREE_PLAN_ACCEPTED_BLOCKED');
    assert.match(result.transitionHistory.summary, /REVISE_COMPLETED_TASK/);
    assert.equal(store.getTask('implement').intent, 'Working app');
    assert.equal(store.getTask('implement').state, 'DONE');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
