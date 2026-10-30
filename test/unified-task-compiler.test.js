import test from 'node:test';
import assert from 'node:assert/strict';
import {compileUnifiedTaskTree} from '../src/v2/unified-task-compiler.js';
import {buildExecutionGraph} from '../src/v2/execution-graph.js';
import { scopeOfTask } from '../src/v2/control-task-policy.js';
const root='/home/shootingsyh/srpg-project/game/.ariad/artifacts';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
// The fixture is the live SRPG planner tree, which grows by design when a
// planning batch lands a new task (78 -> 79 when batch-45 added a fix).
// Derive expectations from the milestone artifacts themselves: every task
// entry appears exactly once in the compiled tree, with each milestone's
// integration entry becoming that milestone's aggregate task.
const milestoneDocs=readdirSync(join(root,'planner','milestones')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(root,'planner','milestones',f),'utf8')));
const expectedTaskCount=milestoneDocs.reduce((n,d)=>n+(d.tasks?.length??0),0);
test('unified compiler emits runnable delivery-shaped tasks without mutating artifacts',()=>{
 const result=compileUnifiedTaskTree(root);
 assert.equal(result.tasks.length,expectedTaskCount);
 assert.equal(result.tasks.filter(t=>t.executionMode==='aggregate').length,milestoneDocs.length);
 assert.equal(result.executionOrder.length,expectedTaskCount);
 const graph=buildExecutionGraph(result.tasks.map(t=>({...t,state:'READY',stage:'developer'})));
 for(const task of result.tasks.filter(t=>t.executionMode==='aggregate')){
   assert.equal(scopeOfTask(task),'delivery');
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

test('prepared unified loader refuses unprepared, in-flight, or drifted projects',async()=>{
 const {loadPreparedUnifiedTaskTree}=await import('../src/v2/unified-task-compiler.js');
 const compiled=compileUnifiedTaskTree(root);
 let project={unifiedTaskCompilerVersion:1,deliveryEnabled:true,unifiedTaskHistoricalExceptions:[]};
 let rows=compiled.tasks.map(t=>({...t}));
 const store={getProject:()=>project,listTasks:()=>rows};
 // The human delivery gate is the scheduler's dispatch concern; the loader
 // ignores it and loads while no delivery execution is in flight.
 assert.equal(loadPreparedUnifiedTaskTree({artifactRoot:root,store,projectId:'p'}).tasks.length,expectedTaskCount);
 rows=rows.map((t,i)=>i===0?{...t,state:'WORKING'}:t);
 assert.throws(()=>loadPreparedUnifiedTaskTree({artifactRoot:root,store,projectId:'p'}),/DELIVERY_IN_FLIGHT/);
 rows=rows.slice(1);
 assert.throws(()=>loadPreparedUnifiedTaskTree({artifactRoot:root,store,projectId:'p'}),/STORE_DRIFT/);
});
