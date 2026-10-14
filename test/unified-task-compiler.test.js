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

test('compiler/store verifier flags missing and incompatible migrated tasks',async()=>{
 const {verifyUnifiedCompilerAgainstStore}=await import('../src/v2/unified-task-compiler.js');
 const compiled=compileUnifiedTaskTree(root);
 const rows=compiled.tasks.map(t=>({...t,unifiedTaskSchemaVersion:1}));
 const store={listTasks:()=>rows};
 assert.equal(verifyUnifiedCompilerAgainstStore({artifactRoot:root,store,projectId:'p'}).ok,true);
 rows[0]={...rows[0],dependsOn:['invalid']};
 const mismatch=verifyUnifiedCompilerAgainstStore({artifactRoot:root,store,projectId:'p'});
 assert.equal(mismatch.ok,false);
 assert.equal(mismatch.issues[0].code,'DEPENDENCY_DRIFT');
});

test('prepared unified loader refuses unprepared, unlocked, or drifted projects',async()=>{
 const {loadPreparedUnifiedTaskTree}=await import('../src/v2/unified-task-compiler.js');
 const compiled=compileUnifiedTaskTree(root);
 let project={unifiedTaskCompilerVersion:1,deliveryEnabled:false,unifiedTaskHistoricalExceptions:[]};
 let rows=compiled.tasks.map(t=>({...t}));
 const store={getProject:()=>project,listTasks:()=>rows};
 assert.equal(loadPreparedUnifiedTaskTree({artifactRoot:root,store,projectId:'p'}).tasks.length,78);
 project={...project,deliveryEnabled:true};
 assert.throws(()=>loadPreparedUnifiedTaskTree({artifactRoot:root,store,projectId:'p'}),/DELIVERY_NOT_LOCKED/);
 project={...project,deliveryEnabled:false};
 rows=rows.slice(1);
 assert.throws(()=>loadPreparedUnifiedTaskTree({artifactRoot:root,store,projectId:'p'}),/STORE_DRIFT/);
});
