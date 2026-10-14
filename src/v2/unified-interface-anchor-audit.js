import {readFileSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {loadBoundaryContracts} from './interface-contracts.js';

// Read-only source-anchor freshness audit. Hash mismatch is stale evidence,
// not proof of a functional defect. No files or historical records are changed.
export function auditInterfaceSourceAnchors(artifactRoot,sourceRoot) {
 const issues=[];const anchors=[];const files=new Map();
 const root=resolve(sourceRoot);
 for(const kind of ['feature','milestone']) {
  for(const contract of loadBoundaryContracts(artifactRoot,kind).values()) {
   for(const binding of contract.bindings??[]) {
    for(const anchor of binding.realizationAnchors??[]) {
     const key={nodeId:contract.nodeId,interfaceId:binding.interfaceId,file:anchor.file,kind:anchor.kind};
     const absolute=resolve(root,anchor.file??'');
     const rel=relative(root,absolute);
     if(!anchor.file || isAbsolute(anchor.file) || rel==='..' || rel.startsWith('..'+sep)) {
      issues.push({...key,code:'UNSAFE_ANCHOR_PATH'});continue;
     }
     if(!existsSync(absolute)) {issues.push({...key,code:'ANCHOR_FILE_MISSING'});continue;}
     if(!files.has(absolute)) {
      const bytes=readFileSync(absolute);
      files.set(absolute,{hash:createHash('sha256').update(bytes).digest('hex'),lines:bytes.toString('utf8').split(/\r?\n/)});
     }
     const file=files.get(absolute);
     if(anchor.fileHash && file.hash!==anchor.fileHash) {
      issues.push({...key,code:'ANCHOR_HASH_STALE'});
     }
     if(!Number.isInteger(anchor.startLine)||anchor.startLine<1||anchor.startLine>file.lines.length ||
        !Number.isInteger(anchor.endLine)||anchor.endLine<anchor.startLine||anchor.endLine>file.lines.length) {
      issues.push({...key,code:'ANCHOR_LINE_INVALID'});
     } else if(anchor.kind==='symbol' && typeof anchor.symbol==='string' &&
               !file.lines[anchor.startLine-1].includes(anchor.symbol)) {
      issues.push({...key,code:'ANCHOR_SYMBOL_MOVED'});
     }
     anchors.push({...key,status:anchor.status});
    }
   }
  }
 }
 return {ok:issues.length===0,issues,anchorCount:anchors.length,fileCount:files.size};
}
