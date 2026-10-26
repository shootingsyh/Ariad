import {mkdtempSync,cpSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AriadProjectManager} from '../src/runtime/project-manager.js';
import {StandaloneProjectRuntime} from '../src/runtime/standalone-project-runtime.js';
import {PiAgentSessionProvider} from '../src/runtime/pi-agent-session-provider.js';
const root=process.env.ARIAD_REAL_E2E_ROOT??mkdtempSync(join(tmpdir(),'ariad-real-tracker-'));
const manager=new AriadProjectManager({projectsRoot:root});
const original=manager.list().find(x=>x.id==='tracker-real-codex');
const roleModels=Object.fromEntries(['artist','developer','tester','reviewer','project_debugger','tech_lead','tech_lead_critic','pm'].map(x=>[x,'openai-codex/gpt-5.6-sol']));
const project=original??manager.create('tracker-real-codex',{goal:'Build a responsive vanilla JS task tracker with persistence, filters and automated tests',roleModels});
const workspace=project.workspace;
if(!original){
 const source='/tmp/ariad-dsl-smoke-20261025/mini-web-e2e/workspace/.ariad/artifacts/planner';
 cpSync(source,join(workspace,'.ariad','artifacts','planner'),{recursive:true});
}
const provider=new PiAgentSessionProvider();
const runtime=new StandaloneProjectRuntime({project,provider,resolveRoleModel:()=> 'openai-codex/gpt-5.6-sol'});
const store=runtime.store;
if(!store.listTasks(project.id).length){
 const p=store.getProject(project.id);
 // Isolated E2E harness explicitly authorizes delivery; production PM gate is unchanged.
 store.updateProject(project.id,p.version,{deliveryEnabled:true,e2eAuthorization:'ISOLATED_TEST_HARNESS'});
 const specs=[
 ['task-core','Implement the task data model and persistence in src/task-core.js; export add/toggle/delete/load operations, use localStorage, handle malformed stored data. Add tests in test/task-core.test.js using node:test.','core-milestone',[]],
 ['task-view','Implement accessible responsive DOM view in src/task-view.js with All/Active/Completed filters, add, toggle, delete, focus management, and no dependencies. Add tests in test/task-view.test.js.','view-milestone',[]],
 ['web-app','Integrate task-core and task-view into index.html, styles.css and src/main.js. Ensure usable website and end-to-end node:test integration tests; update README with instructions.','integration-milestone',['task-core','task-view']],
 ];
 for(const [id,intent,milestoneId,dependsOn] of specs)store.createTask({
  id,projectId:project.id,scope:'delivery',taskKind:'MILESTONE_TASK',stage:'developer',state:'READY',
  milestoneId,dependsOn,input:{intent,acceptanceCriteria:['Functional behavior works','Automated tests verify behavior'],milestoneId},
  title:id,intent,acceptanceCriteria:['Functional behavior works','Automated tests verify behavior']
 });
}
console.log('E2E_ROOT',root,'WORKSPACE',workspace,flush());
function flush(){return store.listTasks(project.id).map(x=>x.id+':'+x.stage+'/'+x.state).join(' ');}
let previous='';
const deadline=Date.now()+12*60*1000;
while(Date.now()<deadline){
 try{
  const r=await runtime.tick();
  const current=flush();
  if(current!==previous){console.log(new Date().toISOString(),current);previous=current;}
  if(store.listTasks(project.id).every(x=>x.state==='DONE'))break;
  if(store.listTasks(project.id).some(x=>['NEEDS_HUMAN','SYSTEM_BLOCKED'].includes(x.state)))break;
 }catch(e){console.error('E2E_ERROR',e.stack);break;}
 await new Promise(r=>setTimeout(r,4000));
}
console.log('FINAL',flush(),'FILES',JSON.stringify(['index.html','styles.css','src/task-core.js','src/task-view.js','src/main.js','README.md'].map(x=>[x,existsSync(join(workspace,x))])));
runtime.close();
await provider.close?.();
