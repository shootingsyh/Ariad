import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/workflow.js';
import { ScriptedFakeExecutor } from '../src/fake-executor.js';
const pass = outcome => ({ executionStatus: 'COMPLETED', outcome });
test('happy path developer -> tester -> reviewer -> done', async()=>{const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY')],tester:[pass('PASS')],reviewer:[pass('PASS')]});const wf=new WorkflowEngine(exec);const result=await wf.runFeature('F1');assert.equal(result.status,'SUCCEEDED');assert.deepEqual(exec.calls.map(c=>c.role),['developer','tester','reviewer']);});
test('tester NOT_PASS increments semantic cycle and returns to developer', async()=>{const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY')],tester:[pass('NOT_PASS'),pass('PASS')],reviewer:[pass('PASS')]});const result=await new WorkflowEngine(exec).runFeature('F2');assert.equal(result.devCycle,2);assert.deepEqual(exec.calls.map(c=>c.role),['developer','tester','developer','tester','reviewer']);});
test('reviewer NOT_PASS increments semantic cycle and returns to developer', async()=>{const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY')],tester:[pass('PASS'),pass('PASS')],reviewer:[pass('NOT_PASS'),pass('PASS')]});const result=await new WorkflowEngine(exec).runFeature('F3');assert.equal(result.devCycle,2);});
test('fourth developer entry is blocked by project debugger and oversized work goes to Tech Lead', async()=>{const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY')],tester:[pass('NOT_PASS'),pass('NOT_PASS'),pass('NOT_PASS')],project_debugger:[pass('TASK_TOO_LARGE')],tech_lead:[pass('REPLANNED')]});const result=await new WorkflowEngine(exec).runFeature('F4');assert.equal(result.status,'WAITING_REPLAN');assert.equal(exec.calls.filter(c=>c.role==='developer').length,3);assert.equal(exec.calls.at(-2)?.role,'project_debugger');assert.equal(exec.calls.at(-1)?.role,'tech_lead');});
test('project debugger WRONG_IMPLEMENTATION_APPROACH starts new strategy epoch and resets dev cycle', async()=>{const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY')],tester:[pass('NOT_PASS'),pass('NOT_PASS'),pass('NOT_PASS'),pass('PASS')],project_debugger:[pass('WRONG_IMPLEMENTATION_APPROACH')],reviewer:[pass('PASS')]});const result=await new WorkflowEngine(exec).runFeature('F5');assert.equal(result.status,'SUCCEEDED');assert.equal(result.strategyEpoch,2);assert.equal(result.devCycle,1);});
test('TASK_CONTRADICTORY becomes a PM/user decision point and preserves history', async()=>{const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY')],tester:[pass('NOT_PASS'),pass('NOT_PASS'),pass('NOT_PASS')],project_debugger:[pass('TASK_CONTRADICTORY')]});const result=await new WorkflowEngine(exec).runFeature('F6');assert.equal(result.status,'NEEDS_HUMAN');assert.equal(result.history.some(e=>e.role==='project_debugger'),true);});
test('system execution failure does not increment dev cycle or invoke project debugger', async()=>{const exec=new ScriptedFakeExecutor({developer:[{executionStatus:'FAILED',failure:'MODEL_DOWN'},pass('IMPLEMENTATION_READY')],tester:[pass('PASS')],reviewer:[pass('PASS')]});const result=await new WorkflowEngine(exec,{maxSystemRetries:2}).runFeature('F7');assert.equal(result.status,'SUCCEEDED');assert.equal(result.devCycle,1);assert.equal(exec.calls.some(c=>c.role==='project_debugger'),false);});
test('system retry exhaustion escalates to reliability rather than project debugger', async()=>{const exec=new ScriptedFakeExecutor({developer:[{executionStatus:'FAILED',failure:'MODEL_DOWN'},{executionStatus:'FAILED',failure:'MODEL_DOWN'},{executionStatus:'FAILED',failure:'MODEL_DOWN'}]});const result=await new WorkflowEngine(exec,{maxSystemRetries:2}).runFeature('F8');assert.equal(result.status,'PAUSED_SYSTEM');assert.equal(result.devCycle,1);assert.equal(exec.calls.some(c=>c.role==='project_debugger'),false);});

test('source-control finalizer runs exactly once and only after reviewer PASS', async()=>{
  const calls=[];
  const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY')],tester:[pass('PASS'),pass('PASS')],reviewer:[pass('NOT_PASS'),pass('PASS')]});
  const result=await new WorkflowEngine(exec,{finalizeSourceControl:async ctx=>{calls.push(ctx);return {ok:true,commit:'abc'};}}).runFeature('F9');
  assert.equal(result.status,'SUCCEEDED');
  assert.equal(calls.length,1);
  assert.equal(calls[0].devCycle,2);
});

test('source-control finalizer failure is system failure, not reviewer rejection', async()=>{
  const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY')],tester:[pass('PASS')],reviewer:[pass('PASS')]});
  const result=await new WorkflowEngine(exec,{finalizeSourceControl:async()=>({ok:false,error:'push rejected'})}).runFeature('F10');
  assert.equal(result.status,'PAUSED_SYSTEM');
  assert.equal(result.devCycle,1);
});

test('unknown project debugger diagnosis requires human rather than guessing', async()=>{
  const exec=new ScriptedFakeExecutor({developer:[pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY'),pass('IMPLEMENTATION_READY')],tester:[pass('NOT_PASS'),pass('NOT_PASS'),pass('NOT_PASS')],project_debugger:[pass('UNKNOWN_PROJECT_CAUSE')]});
  const result=await new WorkflowEngine(exec).runFeature('F11');
  assert.equal(result.status,'NEEDS_HUMAN');
});

test('strategy epochs are bounded to prevent debugger loops', async()=>{
  const many=n=>Array.from({length:n},()=>pass('IMPLEMENTATION_READY'));
  const rejects=n=>Array.from({length:n},()=>pass('NOT_PASS'));
  const exec=new ScriptedFakeExecutor({developer:many(6),tester:rejects(6),project_debugger:[pass('WRONG_IMPLEMENTATION_APPROACH'),pass('WRONG_IMPLEMENTATION_APPROACH')]});
  const result=await new WorkflowEngine(exec,{maxStrategyEpochs:2}).runFeature('F12');
  assert.equal(result.status,'NEEDS_HUMAN');
  assert.equal(result.strategyEpoch,2);
});
