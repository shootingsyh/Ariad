import test from 'node:test';
import assert from 'node:assert/strict';
import { auditUnifiedInterfaceBindings } from '../src/v2/unified-interface-audit.js';
import { compileUnifiedTaskTree } from '../src/v2/unified-task-compiler.js';

const root='/home/shootingsyh/srpg-project/game/.ariad/artifacts';
test('unified task interface declarations resolve against canonical boundary contracts',()=>{
 const audit=auditUnifiedInterfaceBindings(root);
 assert.equal(audit.ok,true,JSON.stringify(audit.issues));
 assert.equal(audit.taskCount,compileUnifiedTaskTree(root).tasks.length);
 assert.ok(audit.definedInterfaceCount>0);
});
