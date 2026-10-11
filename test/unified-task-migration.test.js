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
