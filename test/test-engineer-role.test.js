import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { piRoleResultToolSchema, piDeclaredRoleResultToolSchema } from '../src/runtime/pi-agent-session-provider.js';
import { Check } from 'typebox/value';

const roles = createDefaultV2Roles({store:{},workspace:'/tmp'});
const task = {id:'act1',projectId:'srpg',stage:'test_engineer',acceptanceCriteria:[{id:'AC1'},{id:'AC2'}],history:[]};
const plan = {scope:['CH1-6'],excluded:['A2','A3','HX1'],testCases:[{id:'a1',entry:'tests/__integration_tests__/a1.gd',command:'godot -s tests/__integration_tests__/a1.gd',covers:['AC1','AC2'],executionScope:['CH1-6']}],testRepairs:[]};

test('developer hands off to test engineer, not directly tester',()=>{
 assert.equal(roles.developer.transition().stage,'test_engineer');
 assert.match(roles.test_engineer.prepare({task}).context.roleProtocol,/authoring|repair/i);
});
test('test engineer plan gates tester and is validated in role result schema',()=>{
 assert.equal(roles.test_engineer.transition({task,result:{outcome:'PASS',result:{testPlan:plan}}}).stage,'tester');
 assert.equal(roles.test_engineer.transition({task,result:{outcome:'PASS',result:{testPlan:{...plan,testCases:[]}}}}).stage,'project_debugger');
 assert.equal(Check(piRoleResultToolSchema('test_engineer'),{outcome:'PASS',summary:'ready',result:{testPlan:plan}}),true);
 assert.equal(Check(piRoleResultToolSchema('test_engineer'),{outcome:'PASS',summary:'ready',result:{testPlan:{}}}),false);
 assert.ok(piDeclaredRoleResultToolSchema('test_engineer'));
});
test('tester requires approved plan and routes invalid plan back to engineer',()=>{
 const testerTask={...task,stage:'tester'};
 assert.throws(()=>roles.tester.prepare({task:testerTask}),/TEST_PLAN_MISSING/);
 const approved={...testerTask,history:[{type:'ROLE_RESULT',role:'test_engineer',outcome:'PASS',result:{testPlan:plan}}]};
 assert.deepEqual(roles.tester.prepare({task:approved}).context.approvedTestPlan,plan);
 assert.equal(roles.tester.transition({task:approved,result:{outcome:'NOT_PASS',result:{testPlanInvalid:true}}}).stage,'test_engineer');
});
