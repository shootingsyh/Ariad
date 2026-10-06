import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateFeatureDecompositionIteration } from '../src/v2/feature-decomposition-validator.js';

const put = (file, data) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n'); };
const iface = (id, withEvidence=true) => ({
 id,kind:'executor',visibility:'exported',contract:{input:['request'],output:['result'],sideEffects:[]},
 ...(withEvidence ? {verificationSketch:'Exercise the interface through supported input'} : {}),
});
const task = (id) => ({id,title:'Verify new feature',intent:'Reuse current implementation and verify behavior',
 acceptanceCriteria:['AC1: Behavior correct'],testStrategy:'Run actual user journey',
 verification:[{criterionId:'AC1',mode:'behavioral',target:'user journey'}],
 interfaceIds:['run']});
function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ariad-decomp-gate-'));
 const logical=(id,parentId)=>put(path.join(root,'planner/logical',id+'.json'),{id,parentId,title:id,summary:id});
 logical('root',null);logical('child','root');
 const parent={version:1,nodeId:'root',nodeType:'feature',
   decomposition:{kind:'expand',reason:'Separate bounded behaviors'},
   interfaces:[iface('parent')],
   imports:[{fromNodeId:'child',interfaceId:'run',purpose:'Integrate child behavior'}],
   integrationScenarios:[{id:'parent-e2e',description:'Normal user entry to completed outcome',
    uses:[{graph:'feature',nodeId:'child',interfaceId:'run'}]}],
   featureTasks:[]};
 const child={version:1,nodeId:'child',nodeType:'feature',
   decomposition:{kind:'leaf',reason:'Cohesive behavior'},
   interfaces:[iface('run')],imports:[],integrationScenarios:[],
   featureTasks:[task('child-verification')]};
 const dir=path.join(root,'planner/interfaces/features');
 put(path.join(dir,'root.json'),parent);put(path.join(dir,'child.json'),child);
 return {root,parent,child,dir};
}
const diff={version:1,targetVersion:2,operations:[{op:'add',node:{id:'child',parentId:'root',title:'child',summary:'child'},reason:'split'}]};
const tasks=[{...task('child-verification'),logicalRefs:['child']}];
test('decomposition accepts complete feature/interface/verification ownership with reuse',()=>{
 const f=fixture();
 try{assert.deepEqual(validateFeatureDecompositionIteration(f.root,diff,tasks),
 {ok:true,addedFeatures:1,changedParents:1});}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('decomposition rejects missing interface verification plan',()=>{
 const f=fixture();
 try{f.child.interfaces=[iface('run',false)];put(path.join(f.dir,'child.json'),f.child);
 assert.throws(()=>validateFeatureDecompositionIteration(f.root,diff,tasks),/requires verificationSketch/);}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('decomposition rejects unintegrated new child',()=>{
 const f=fixture();
 try{f.parent.integrationScenarios=[];put(path.join(f.dir,'root.json'),f.parent);
 assert.throws(()=>validateFeatureDecompositionIteration(f.root,diff,tasks),/must integrate child/);}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('decomposition rejects feature leaf without task ownership',()=>{
 const f=fixture();
 try{f.child.featureTasks=[];put(path.join(f.dir,'child.json'),f.child);
 assert.throws(()=>validateFeatureDecompositionIteration(f.root,diff,tasks),/requires a canonical feature task/);}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('decomposition rejects uncompiled task and incomplete task verification',()=>{
 const f=fixture();
 try{
 assert.throws(()=>validateFeatureDecompositionIteration(f.root,diff,[]),/missing from compiled Task Graph/);
 const partial=[{...tasks[0],verification:[]}];
 assert.throws(()=>validateFeatureDecompositionIteration(f.root,diff,partial),/planned verification/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
