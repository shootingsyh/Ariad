import test from 'node:test';
import assert from 'node:assert/strict';
import { plannerFlowTasks } from '../src/v2/planner-flow.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
const requests=[{request:{purpose:'PLANNING_ROUTE',instruction:'Repair interface bindings'}}];
const route={requestType:'INTERFACE_REPAIR',reason:'missing bindings',scope:{featureRoots:['srpg'],milestoneRoots:['V2']},stages:{feature:'SKIP',milestone:'SKIP',interface:'RUN'}};
test('controlled planning route is opt-in and uses existing role registry',()=>{
 const flow=plannerFlowTasks('x',requests);
 assert.deepEqual(flow.map(t=>t.stage),['tech_lead','plan_validator','tech_lead_critic']);
 const roles=createDefaultV2Roles({store:{},workspace:'/tmp'});
 const task={id:'route',projectId:'srpg',scope:'control',input:{purpose:'PLANNING_ROUTE'}};
 const next=roles.tech_lead.transition({task,result:{outcome:'PLANNING_ROUTE',result:route}});
 assert.equal(next.stage,'interface_architect');
 assert.equal(next.input.planningRoute,route);
 assert.equal(roles.interface_architect.transition({task:{...task,input:next.input},result:{outcome:'PASS'}}).state,'DONE');
 assert.equal(roles.interface_architect.transition({task:{...task,input:next.input},result:{outcome:'NOT_PASS'}}).state,'NEEDS_HUMAN');
});
test('specialists execute in feature, milestone, interface order and skip unchanged stages',()=>{
 const roles=createDefaultV2Roles({store:{},workspace:'/tmp'});
 const stages={feature:'RUN',milestone:'SKIP',interface:'RUN'};
 const task={input:{planningRoute:{...route,stages}}};
 assert.equal(roles.feature_planner.transition({task,result:{outcome:'PASS'}}).stage,'interface_architect');
 assert.equal(roles.interface_architect.transition({task,result:{outcome:'PASS'}}).state,'DONE');
});
