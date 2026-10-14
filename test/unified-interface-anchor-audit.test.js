import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditInterfaceSourceAnchors} from '../src/v2/unified-interface-anchor-audit.js';

test('source anchor audit classifies stale hash, moved symbol, and missing file without writing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-anchor-audit-'));
 try {
  const artifacts=join(dir,'artifacts');
  const contracts=join(artifacts,'planner','interfaces','features');
  mkdirSync(contracts,{recursive:true});
  const source=join(dir,'source');mkdirSync(source);
  writeFileSync(join(source,'example.gd'),'# shifted\nfunc actual():\n pass\n');
  const contract={version:1,nodeId:'feature.test',nodeType:'feature',
   decomposition:{kind:'leaf',reason:'test'},interfaces:[{id:'iface',kind:'executor',visibility:'exported',contract:{input:[],output:[],sideEffects:[]},verificationSketch:'test',realization:[],verification:[]}],
   imports:[],integrationScenarios:[],bindings:[{interfaceId:'iface',realizationAnchors:[
    {kind:'symbol',file:'example.gd',symbol:'actual',startLine:1,endLine:1,fileHash:'old',status:'VALID'},
    {kind:'range',file:'missing.gd',startLine:1,endLine:2,status:'VALID'}
   ]}]};
  writeFileSync(join(contracts,'feature.test.json'),JSON.stringify(contract));
  const result=auditInterfaceSourceAnchors(artifacts,source);
  assert.deepEqual(new Set(result.issues.map(i=>i.code)),new Set(['ANCHOR_HASH_STALE','ANCHOR_SYMBOL_MOVED','ANCHOR_FILE_MISSING']));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
