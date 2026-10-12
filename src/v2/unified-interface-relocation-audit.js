import {readFileSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {loadBoundaryContracts} from './interface-contracts.js';

// Read-only: source-location candidates do not establish semantic compatibility.
const migratedTestPaths = Object.freeze({
 'tests/test_rout_policy.gd':'scripts/policies/__integration_tests__/rout_policy__test.gd',
 'tests/test_save_roundtrip.gd':'scripts/autoload/__tests__/game_state__test.gd',
});

export function locateInterfaceSymbols(artifactRoot,sourceRoot) {
 const root=resolve(sourceRoot), results=[], cache=new Map();
 for(const kind of ['feature','milestone']) for(const c of loadBoundaryContracts(artifactRoot,kind).values()) {
  for(const b of c.bindings??[]) for(const a of b.realizationAnchors??[]) {
   if(a.kind!=='symbol') continue;
   const entry={nodeId:c.nodeId,interfaceId:b.interfaceId,file:a.file,symbol:a.symbol,recordedLine:a.startLine};
   const absolute=resolve(root,a.file??''),rel=relative(root,absolute);
   if(!a.file||isAbsolute(a.file)||rel==='..'||rel.startsWith('..'+sep)) {
    results.push({...entry,status:'UNSAFE_PATH'});continue;
   }
   if(!existsSync(absolute)){
    const replacement=migratedTestPaths[a.file];
    if(!replacement){results.push({...entry,status:'FILE_MISSING'});continue;}
    const migrated=resolve(root,replacement);
    if(!existsSync(migrated)){results.push({...entry,status:'MIGRATED_TARGET_MISSING',replacement});continue;}
    const content=readFileSync(migrated,'utf8');
    const symbol=a.symbol.split('.').at(-1);
    const matches=content.split(/\r?\n/).flatMap((line,i)=>line.trimStart().startsWith('func '+symbol+'(')?[i+1]:[]);
    results.push({...entry,status:matches.length===1?'MIGRATED_CANDIDATE':'MIGRATED_UNVERIFIED',replacement,candidateLines:matches});
    continue;
   }
   if(!cache.has(absolute)) cache.set(absolute,readFileSync(absolute,'utf8').split(/\r?\n/));
   const lines=cache.get(absolute);
   const matches=[];
   const symbol=a.symbol.split('.').at(-1);
   lines.forEach((line,i)=>{
    const trimmed=line.trimStart();
    const prefixes=['func ','static func ','class ','class_name ','signal ','const ','var ','enum '];
    if(prefixes.some(prefix=>trimmed.startsWith(prefix+symbol) &&
      !/[A-Za-z0-9_]/.test(trimmed[prefix.length+symbol.length]??''))) matches.push(i+1);
   });
   const status=matches.length===0?'DEFINITION_NOT_FOUND':matches.length>1?'AMBIGUOUS':
    matches[0]===a.startLine?'AT_RECORDED_LINE':'RELOCATED';
   results.push({...entry,status,candidateLines:matches});
  }
 }
 const counts={};for(const r of results) counts[r.status]=(counts[r.status]??0)+1;
 return {symbolCount:results.length,counts,results};
}
