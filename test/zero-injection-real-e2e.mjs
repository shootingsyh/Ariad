// Live acceptance harness: only official CLI operations; no createTask or delivery gate bypass.
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {AriadProjectManager} from '../src/runtime/project-manager.js';
import {SQLiteV2Store} from '../src/v2/sqlite-store.js';

const root=process.env.ARIAD_ZERO_E2E_ROOT??mkdtempSync(join(tmpdir(),'ariad-zero-e2e-'));
const name='task-tracker-zero';
const models=Object.fromEntries(['artist','developer','tester','reviewer','project_debugger','tech_lead','tech_lead_critic','pm'].map(r=>[r,'openai-codex/gpt-5.6-sol']));
const manager=new AriadProjectManager({projectsRoot:root});
const cli=(...args)=>JSON.parse(execFileSync(process.execPath,['src/runtime/cli.js',...args,'--projects-root',root],{cwd:process.cwd(),encoding:'utf8',timeout:45000}));
if(!manager.list().some(p=>p.id===name)){
 cli('project','create',name,'--goal','Build a working accessible responsive task tracker with add, toggle, delete, All/Active/Completed filters, localStorage persistence and automated Node tests. Implement complete runnable plain HTML CSS JavaScript website.','--role-models',JSON.stringify(models));
 const project=manager.status(name);
 const bare=join(root,'origin.git');
 execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
 execFileSync('git',['-C',project.workspace,'remote','add','origin',bare]);
 execFileSync('git',['-C',project.workspace,'-c','user.name=Ariad E2E','-c','user.email=e2e@localhost','commit','--allow-empty','-m','Initialize isolated project'],{stdio:'ignore'});
 execFileSync('git',['-C',project.workspace,'push','-u','origin','main'],{stdio:'ignore'});
}
cli('project','start',name);
const project=manager.status(name);
let last='';
const deadline=Date.now()+12*60*1000;
while(Date.now()<deadline){
 if(existsSync(project.stateDb)){
  let store;
  try { store=new SQLiteV2Store(project.stateDb); } catch(e) {
   if(String(e.message).includes('database is locked')) { await new Promise(r=>setTimeout(r,2000)); continue; }
   throw e;
  }
  const tasks=store.listTasks(name), p=store.getProject(name);
  const delivery=tasks.filter(t=>t.scope==='delivery');
  const state=JSON.stringify({gate:p?.deliveryEnabled,delivery:delivery.map(t=>[t.id,t.state,t.stage]),planning:tasks.filter(t=>t.scope==='control'&&!['DONE','SKIPPED'].includes(t.state)).length});
  if(state!==last){console.log(new Date().toISOString(),state);last=state;}
  const done=delivery.length>0&&delivery.every(t=>t.state==='DONE');
  const blocked=tasks.some(t=>['NEEDS_HUMAN','SYSTEM_BLOCKED'].includes(t.state));
  store.close();
  if(done||blocked){console.log('FINAL',done?'DONE':'BLOCKED');break;}
 }
 await new Promise(r=>setTimeout(r,5000));
}
console.log('ROOT',root,'INDEX_EXISTS',existsSync(join(project.workspace,'index.html')));
