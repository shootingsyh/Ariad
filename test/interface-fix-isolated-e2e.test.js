import test from 'node:test';
import assert from 'node:assert/strict';
import { runNodePlanning } from '../src/v2/node-planning-runner.js';
const nodes=[{id:'root',parentId:null,title:'SRPG'}, {id:'combat',parentId:'root',title:'Combat'}, {id:'movement',parentId:'root',title:'Movement'}];
test('isolated interface fix: only interface planner, bottom-up, all deterministic gates',async()=>{
 const calls=[];
 const result=await runNodePlanning({phase:'interface',nodes,rootId:'root',provider:async ({step,context})=>{
  calls.push({kind:step.kind,id:step.nodeId,context});
  return {passed:true};
 }});
 assert.equal(result.status,'PASS');
 assert.deepEqual(calls.filter(x=>x.kind==='planner').map(x=>x.id),['combat','movement','root']);
 assert.deepEqual(calls.filter(x=>x.kind==='node_validator').map(x=>x.id),['combat','movement','root']);
 assert.deepEqual(calls.filter(x=>x.kind==='parent_critic').map(x=>x.id),['root']);
 assert.deepEqual(calls.slice(-2).map(x=>x.kind),['global_validator','global_critic']);
 assert.equal(calls.some(x=>x.kind==='feature_planner'||x.kind==='milestone_planner'),false);
 assert.deepEqual(calls[0].context.existingChildren,[]);
 assert.equal(calls[2].context.nodeId,'movement');
});
test('isolated interface fix: failed node gate retries same node, then continues',async()=>{
 const seen=[];
 let failures=0;
 const result=await runNodePlanning({phase:'interface',nodes,rootId:'root',provider:async ({step})=>{
  seen.push(`${step.kind}:${step.nodeId}`);
  if(step.kind==='node_validator' && step.nodeId==='combat' && failures++===0) return {passed:false};
  return {passed:true};
 }});
 assert.equal(result.status,'PASS');
 assert.deepEqual(seen.slice(0,4),['planner:combat','node_validator:combat','planner:combat','node_validator:combat']);
});
test('isolated interface fix: global critic failure returns to TL and does not pass',async()=>{
 const result=await runNodePlanning({phase:'interface',nodes,rootId:'root',provider:async ({step})=>({passed:step.kind!=='global_critic'})});
 assert.equal(result.status,'RETURN_TO_TECH_LEAD');
 assert.equal(result.checkpoint.cursor,result.cursor);
});
test('isolated interface fix: checkpoint resume skips completed nodes',async()=>{
 const seen=[];
 const provider=async ({step})=>{seen.push(step.kind+':'+step.nodeId);return {passed:true};};
 const full=await runNodePlanning({phase:'interface',nodes,rootId:'root',provider});
 const cutoff=2;
 const resumedCalls=[];
 const resumed=await runNodePlanning({phase:'interface',nodes,rootId:'root',provider:async ({step})=>{resumedCalls.push(step);return {passed:true};},checkpoint:{cursor:cutoff,records:full.records.slice(0,cutoff)}});
 assert.equal(resumed.status,'PASS');
 assert.equal(resumedCalls.some(s=>s.nodeId==='combat'),false);
});
