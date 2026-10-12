import test from 'node:test';
import assert from 'node:assert/strict';
import {compileUnifiedTaskTree} from '../src/v2/unified-task-compiler.js';
import {buildExecutionGraph} from '../src/v2/execution-graph.js';
const root='/home/shootingsyh/srpg-project/game/.ariad/artifacts';
test('unified compiler emits runnable delivery-shaped tasks without mutating artifacts',()=>{
 const result=compileUnifiedTaskTree(root);
 assert.equal(result.tasks.length,78);
 assert.equal(result.tasks.filter(t=>t.executionMode==='aggregate').length,6);
 assert.equal(result.executionOrder.length,78);
 const graph=buildExecutionGraph(result.tasks.map(t=>({...t,state:'READY',stage:'developer'})));
 for(const task of result.tasks.filter(t=>t.executionMode==='aggregate')){
   assert.equal(task.scope,'delivery');
   assert.equal(task.input.milestoneId,task.milestoneId);
   assert.deepEqual(task.input.interfaceIds,task.interfaceIds);
   assert.ok(graph.prerequisitesOf(task.id).length>0);
 }
});
