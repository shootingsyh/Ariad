import test from 'node:test';
import assert from 'node:assert/strict';
import {validateUnifiedTaskTree} from '../src/v2/unified-task-tree.js';
test('aggregate depends on children and cycles fail closed',()=>{
 const p={tasks:[{id:'parent',parentId:null,dependsOn:['child'],executionMode:'aggregate'},{id:'child',parentId:'parent',dependsOn:[],executionMode:'implementation'}],issues:[]};
 assert.equal(validateUnifiedTaskTree(p).ok,true);
 p.tasks[1].dependsOn=['parent'];assert.throws(()=>validateUnifiedTaskTree(p),/cycle/);
});
import {applyUnifiedTaskMigrationToCopy} from '../src/v2/unified-task-migration.js';
test('migration write path is locked unless isolated copy explicitly confirmed',()=>{
 assert.throws(()=>applyUnifiedTaskMigrationToCopy({}),/isolated database copy/);
});

test('aggregate task remains executable and is blocked only by child prerequisites', async () => {
 const {buildExecutionGraph} = await import('../src/v2/execution-graph.js');
 const tasks=[
  {id:'child',scope:'delivery',state:'READY',stage:'developer',dependsOn:[],executionMode:'implementation'},
  {id:'parent',scope:'delivery',state:'READY',stage:'developer',dependsOn:['child'],executionMode:'aggregate'}
 ];
 assert.equal(buildExecutionGraph(tasks).isRunnable(tasks[0]),true);
 assert.equal(buildExecutionGraph(tasks).isRunnable(tasks[1]),false);
 tasks[0].state='DONE';
 assert.equal(buildExecutionGraph(tasks).isRunnable(tasks[1]),true);
 assert.equal(tasks[1].stage,'developer');
});

test('validator reports legacy completed aggregate with unfinished prerequisites',async()=>{
 const {validateMigratedAggregateStates}=await import('../src/v2/unified-task-migration.js');
 const result=validateMigratedAggregateStates([
  {id:'parent',state:'DONE',executionMode:'aggregate',dependsOn:['child']},
  {id:'child',state:'READY',executionMode:'implementation',dependsOn:[]}
 ]);
 assert.equal(result.ok,false);
 assert.equal(result.issues[0].code,'DONE_AGGREGATE_UNFINISHED_PREREQUISITE');
});
