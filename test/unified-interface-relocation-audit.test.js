import test from 'node:test';
import assert from 'node:assert/strict';
import {locateInterfaceSymbols} from '../src/v2/unified-interface-relocation-audit.js';

test('SRPG historical interface symbols resolve to current definitions or verified migration candidates',()=>{
 const result=locateInterfaceSymbols('/home/shootingsyh/srpg-project/game/.ariad/artifacts','/home/shootingsyh/srpg-project/game');
 assert.equal(result.symbolCount,161);
 assert.equal((result.counts.DEFINITION_NOT_FOUND??0)+(result.counts.FILE_MISSING??0)+(result.counts.MIGRATED_UNVERIFIED??0),0,JSON.stringify(result.counts));
 assert.equal(result.counts.MIGRATED_CANDIDATE,2);
});
