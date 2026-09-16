import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator.js';

test('coordinator leaves work pending while scheduler waits for resource', async () => {
  const transitions=[];
  const scheduler={ tryDispatch:async()=>({status:'WAITING_RESOURCE',resource:'gpu'}) };
  const coordinator=new Coordinator({ scheduler, applyExecutionResult:async (...args)=>transitions.push(args) });
  const work={taskId:'T1',role:'developer',runtimeKey:'local',resources:['gpu']};
  const result=await coordinator.tick([work]);
  assert.deepEqual(result,[{work,status:'WAITING_RESOURCE',resource:'gpu'}]);
  assert.equal(transitions.length,0);
});

test('coordinator leaves work pending while runtime is unhealthy', async () => {
  const transitions=[];
  const scheduler={ tryDispatch:async()=>({status:'BLOCKED_RUNTIME',runtimeKey:'local'}) };
  const coordinator=new Coordinator({ scheduler, applyExecutionResult:async (...args)=>transitions.push(args) });
  const work={taskId:'T2',role:'developer',runtimeKey:'local'};
  const result=await coordinator.tick([work]);
  assert.equal(result[0].status,'BLOCKED_RUNTIME');
  assert.equal(transitions.length,0);
});

test('coordinator applies execution result only after actual dispatch', async () => {
  const applied=[];
  const execution={executionStatus:'COMPLETED',outcome:'PASS',runId:'RUN-1'};
  const scheduler={ tryDispatch:async()=>({status:'DISPATCHED',result:execution}) };
  const coordinator=new Coordinator({ scheduler, applyExecutionResult:async (work,result)=>{applied.push({work,result});return {state:'NEXT'};} });
  const work={taskId:'T3',role:'tester',runtimeKey:'local'};
  const result=await coordinator.tick([work]);
  assert.equal(applied.length,1);
  assert.equal(applied[0].result,execution);
  assert.deepEqual(result,[{work,status:'APPLIED',execution,transition:{state:'NEXT'}}]);
});

test('coordinator processes independent ready work without turning one blocked item into global failure', async () => {
  const applied=[];
  const scheduler={ tryDispatch:async work => work.taskId==='blocked'
    ? {status:'WAITING_RESOURCE',resource:'gpu'}
    : {status:'DISPATCHED',result:{executionStatus:'COMPLETED',outcome:'PASS',runId:`RUN-${work.taskId}`}} };
  const coordinator=new Coordinator({ scheduler, applyExecutionResult:async work=>{applied.push(work.taskId);return {state:'DONE'};} });
  const result=await coordinator.tick([
    {taskId:'blocked',role:'developer',runtimeKey:'local',resources:['gpu']},
    {taskId:'free',role:'reviewer',runtimeKey:'cloud',resources:[]},
  ]);
  assert.deepEqual(applied,['free']);
  assert.equal(result[0].status,'WAITING_RESOURCE');
  assert.equal(result[1].status,'APPLIED');
});
