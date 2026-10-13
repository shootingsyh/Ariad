import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {locateInterfaceSymbols} from '../src/v2/unified-interface-relocation-audit.js';

test('locates relocated symbols and migrated tests with project-supplied hints',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ariad-relocation-'));
 try {
  const artifacts=join(dir,'artifacts'),source=join(dir,'source');
  mkdirSync(join(artifacts,'planner','interfaces','features'),{recursive:true});
  mkdirSync(join(source,'new'),{recursive:true});
  writeFileSync(join(source,'code.gd'),'# moved\nclass_name Example\nstatic func action():\n pass\n');
  writeFileSync(join(source,'new','test.gd'),'func _run():\n pass\n');
  const anchors=[
   {kind:'symbol',file:'code.gd',symbol:'Example.action',startLine:1,endLine:1,status:'VALID'},
   {kind:'symbol',file:'old.gd',symbol:'_run',startLine:3,endLine:3,status:'VALID'},
  ];
  const contract={version:1,nodeId:'feature.test',nodeType:'feature',decomposition:{kind:'leaf',reason:'test'},
   interfaces:[{id:'iface',kind:'executor',visibility:'exported',contract:{input:[],output:[],sideEffects:[]},verificationSketch:'test',realization:[],verification:[]}],
   imports:[],integrationScenarios:[],bindings:[{interfaceId:'iface',realizationAnchors:anchors}]};
  writeFileSync(join(artifacts,'planner','interfaces','features','feature.test.json'),JSON.stringify(contract));
  const opts={migratedPaths:{'old.gd':'new/test.gd'}};
  const result=locateInterfaceSymbols(artifacts,source,opts);
  assert.deepEqual(result.counts,{RELOCATED:1,MIGRATED_CANDIDATE:1});
  assert.deepEqual(locateInterfaceSymbols(artifacts,source).counts,{RELOCATED:1,FILE_MISSING:1});
  assert.equal(locateInterfaceSymbols(artifacts,source,{migratedPaths:{'old.gd':'../escape.gd'}}).counts.UNSAFE_MIGRATED_PATH,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
