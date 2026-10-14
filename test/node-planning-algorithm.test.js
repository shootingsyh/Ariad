import test from 'node:test';
import assert from 'node:assert/strict';
import { nodePlanningSchedule, nodePlanningContext, validateChildPatch, planningGatePolicy } from '../src/v2/node-planning-algorithm.js';
const nodes = [
 {id:'root',title:'Root',parentId:null},
 {id:'B',title:'B',parentId:'root',featureScope:['f2']},
 {id:'A',title:'A',parentId:'root',featureScope:['f1']},
 {id:'A1',title:'A1',parentId:'A'},
];
test('feature planner is deterministic preorder, node validators and parent critics are mandatory',()=>{
 const steps=nodePlanningSchedule({phase:'feature',nodes,rootId:'root'});
 assert.deepEqual(steps.filter(s=>s.kind==='planner').map(s=>s.nodeId),['root','A','A1','B']);
 assert.equal(steps.filter(s=>s.kind==='node_validator').length,4);
 assert.deepEqual(steps.filter(s=>s.kind==='parent_critic').map(s=>s.nodeId),['root','A']);
 assert.deepEqual(steps.slice(-2).map(s=>s.kind),['global_validator','global_critic']);
});
test('interface architect is deterministic postorder',()=>{
 const steps=nodePlanningSchedule({phase:'interface',nodes,rootId:'root'});
 assert.deepEqual(steps.filter(s=>s.kind==='planner').map(s=>s.nodeId),['A1','A','B','root']);
});
test('new plan hides children, replan exposes only direct children; root has no parent',()=>{
 const plan=nodePlanningContext({phase:'feature',operation:'PLAN',nodes,nodeId:'A'});
 const replan=nodePlanningContext({phase:'feature',operation:'REPLAN',nodes,nodeId:'A'});
 assert.equal(plan.parent.id,'root');
 assert.deepEqual(plan.existingChildren,[]);
 assert.deepEqual(replan.existingChildren.map(c=>c.id),['A1']);
 assert.equal(nodePlanningContext({phase:'feature',operation:'PLAN',nodes,nodeId:'root'}).parent,null);
});
test('milestone root sees all feature summaries; descendants only scoped features',()=>{
 const features=[{id:'f1',title:'One',secret:'exclude'},{id:'f2',title:'Two'}];
 const root=nodePlanningContext({phase:'milestone',operation:'PLAN',nodes,nodeId:'root',featureManifest:features});
 const a=nodePlanningContext({phase:'milestone',operation:'PLAN',nodes,nodeId:'A',featureManifest:features});
 assert.deepEqual(root.featureManifest.map(f=>f.id),['f1','f2']);
 assert.deepEqual(a.featureManifest.map(f=>f.id),['f1']);
 assert.equal('secret' in root.featureManifest[0],false);
});
test('patch may only change direct children, and cannot silently remove subtrees',()=>{
 assert.equal(validateChildPatch({nodes,parentId:'root',operations:[{op:'KEEP',nodeId:'A'},{op:'ADD',node:{id:'C',parentId:'root'}}]}),true);
 assert.throws(()=>validateChildPatch({nodes,parentId:'root',operations:[{op:'REMOVE',nodeId:'A'}]}),/descendant/);
 assert.throws(()=>validateChildPatch({nodes,parentId:'root',operations:[{op:'UPDATE',nodeId:'A1',changes:{title:'X'}}]}),/direct child/);
 assert.throws(()=>validateChildPatch({nodes,parentId:'root',operations:[{op:'ADD',node:{id:'C',parentId:'A'}}]}),/direct child/);
});
test('policy is fixed, not LLM-selected',()=>{
 assert.deepEqual(planningGatePolicy().gates,['node_validator','parent_critic','global_validator','global_critic']);
 assert.equal(planningGatePolicy().nodeRepairLimit,2);
});

test('gate retries exactly twice, then debugger; global failure returns to TL', async()=>{
 const {resolvePlanningGate}=await import('../src/v2/node-planning-algorithm.js');
 assert.deepEqual(resolvePlanningGate({kind:'node_validator',passed:false,attempts:0}),{action:'RETRY_NODE',nextAttempt:1});
 assert.deepEqual(resolvePlanningGate({kind:'parent_critic',passed:false,attempts:1}),{action:'RETRY_NODE',nextAttempt:2});
 assert.deepEqual(resolvePlanningGate({kind:'parent_critic',passed:false,attempts:2}),{action:'PROJECT_DEBUGGER'});
 assert.deepEqual(resolvePlanningGate({kind:'global_critic',passed:false}),{action:'RETURN_TO_TECH_LEAD'});
});
