import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUnifiedTaskTree } from '../src/v2/unified-task-tree.js';
test('unified task graph validates hierarchy and dependencies', () => {
 const p={tasks:[{id:'root',parentId:null,dependsOn:[],executionMode:'aggregate'},{id:'leaf',parentId:'root',dependsOn:[],executionMode:'implementation'}],issues:[]};
 assert.deepEqual(validateUnifiedTaskTree(p),{ok:true,issues:[]});
 p.tasks[0].dependsOn=['leaf'];p.tasks[1].dependsOn=['root'];
 assert.throws(()=>validateUnifiedTaskTree(p),/cycle/);
});
