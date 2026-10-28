import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAgentSessionProvider, isCodexQuotaExhaustion } from '../src/runtime/pi-agent-session-provider.js';

const codex='openai-codex/gpt-5.6-sol';
const muse='meta/muse-spark-1.2-contributor';
async function execute({primaryError, roleModelRef=codex, fallbackError=null}) {
  const calls=[];
  let disposed=0;
  const provider=new PiAgentSessionProvider({
    createRunSession:async spec=>{
      const active=spec.context.roleModelRef;
      calls.push({model:active,policy:spec.sessionPolicy,attempt:spec.attemptId});
      const session={messages:[],
        async prompt(message){
          this.messages.push({role:'user',content:message});
          const fail=active===codex?primaryError:fallbackError;
          if(fail)this.messages.push({role:'assistant',stopReason:'error',errorMessage:fail});
        },
        dispose(){disposed++;}
      };
      return {
        session,
        getTerminalResult:()=>((active===codex?primaryError:fallbackError)?null:{
          outcome:'PLANNED',summary:'Completed using '+active,keyPoints:[]}),
      };
    },
  });
  const handle=await provider.start({
    projectId:'P',taskId:'TL',role:'tech_lead',attemptId:'P:TL:1',
    sessionPolicy:'persistent',context:{role:'tech_lead',roleModelRef,
      roleModels:{tech_lead:roleModelRef},sessionKey:'tech_lead:P'},
    prompt:'Plan the work',
  });
  await provider.runs.get(handle.externalId).promise;
  const state=await provider.poll(handle);
  await provider.close();
  return {calls,state,disposed};
}
test('Codex account quota fails over to a fresh Muse session for this attempt',async()=>{
 const r=await execute({primaryError:'Codex error: The usage limit has been reached'});
 // No in-place transplant: a SECOND session is created from the fallback
 // spec (fresh policy, suffixed attempt), and the abandoned primary
 // session is disposed as well as the fallback one.
 assert.deepEqual(r.calls,[{model:codex,policy:'persistent',attempt:'P:TL:1'},{model:muse,policy:'fresh',attempt:'P:TL:1:quota-fallback'}]);
 assert.equal(r.state.state,'COMPLETED');
 assert.match(r.state.summary,/meta\/muse/);
 assert.ok(r.state.keyPoints.some(x=>x.includes('ARIAD_MODEL_QUOTA_FALLBACK')));
 assert.ok(r.state.keyPoints.some(x=>x.includes('fresh session')));
 assert.equal(r.disposed,2);
 // Next new task/attempt always starts with primary Codex, not Muse.
 const next=await execute({primaryError:null});
 assert.deepEqual(next.calls.map(x=>x.model),[codex]);
 assert.equal(next.disposed,1);
});
test('quota fallback is not used for errors unrelated to quota',async()=>{
 const r=await execute({primaryError:'404: model not found'});
 assert.equal(r.state.state,'FAILED');
 assert.deepEqual(r.calls.map(x=>x.model),[codex]);
});
test('Muse fallback failures remain failures; do not claim success',async()=>{
 const r=await execute({primaryError:'usage limit has been reached',fallbackError:'Muse auth denied'});
 assert.equal(r.state.state,'FAILED');
 assert.match(r.state.failure,/Muse auth denied/);
 assert.deepEqual(r.calls,[{model:codex,policy:'persistent',attempt:'P:TL:1'},{model:muse,policy:'fresh',attempt:'P:TL:1:quota-fallback'}]);
});
test('other providers are never forced through Codex fallback',async()=>{
 const r=await execute({roleModelRef:muse,primaryError:null});
 assert.equal(r.state.state,'COMPLETED');
 assert.deepEqual(r.calls.map(x=>x.model),[muse]);
});
test('quota classifier excludes generic transient rate limits',()=>{
 assert.equal(isCodexQuotaExhaustion('429 Too Many Requests'),false);
 assert.equal(isCodexQuotaExhaustion('Codex error: The usage limit has been reached'),true);
 assert.equal(isCodexQuotaExhaustion('insufficient_quota'),true);
});

test('live ChatGPT Plus quota message starts a fresh Muse session',async()=>{
 const message='You have hit your ChatGPT usage limit (plus plan). Try again in ~272 min.';
 assert.equal(isCodexQuotaExhaustion(message),true);
 const r=await execute({primaryError:message});
 assert.equal(r.state.state,'COMPLETED');
 assert.equal(r.disposed,2);
 assert.deepEqual(r.calls,[{model:codex,policy:'persistent',attempt:'P:TL:1'},{model:muse,policy:'fresh',attempt:'P:TL:1:quota-fallback'}]);
 const next=await execute({primaryError:null});
 assert.deepEqual(next.calls.map(x=>x.model),[codex]);
});
