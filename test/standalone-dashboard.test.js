import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { AriadDashboardService } from '../src/runtime/dashboard-service.js';
import { runAriadRuntimeCli } from '../src/runtime/cli.js';

test('standalone dashboard serves migrated UI and live planner hierarchy without OpenClaw', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-dashboard-'));
  const models = Object.fromEntries(['artist','developer','tester','reviewer','project_debugger','tech_lead','tech_lead_critic','pm'].map(role => [role, 'llamacpp/local-test']));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const project = manager.create('demo', { goal: 'dashboard smoke', roleModels: models });
  const logicalDir = path.join(project.workspace,'.ariad','artifacts','planner','logical');
  fs.mkdirSync(logicalDir, {recursive:true});
  fs.writeFileSync(path.join(logicalDir,'demo.json'),JSON.stringify({id:'demo',title:'Demo',summary:'demo',parentId:null}));
  const dashboard = new AriadDashboardService({ manager, port: 0 });
  try {
    await dashboard.start();
    const base = dashboard.url;
    const html = await fetch(base);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<html|<!doctype/i);
    const projects = await (await fetch(base+'/api/projects')).json();
    assert.equal(projects.length,1);
    assert.equal(projects[0].project.id,'demo');
    const versions = await (await fetch(base+'/api/projects/demo/versions')).json();
    assert.equal(versions.at(-1).featureCount,1);
    const active = await (await fetch(base+'/api/projects/demo/versions/'+versions.at(-1).version)).json();
    assert.deepEqual(active.logicalNodes.map(node=>node.id),['demo']);
    const post = await fetch(base+'/api/projects',{method:'POST'});
    assert.equal(post.status,405);
  } finally {
    await dashboard.stop();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('CLI manages standalone dashboard lifecycle through daemon', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-dashboard-daemon-'));
  try {
    const args=(...parts)=>[...parts,'--projects-root',root];
    const result = await runAriadRuntimeCli(args('dashboard','start','--port','18794'));
    assert.equal(result.running,true);
    assert.equal(result.address.port,18794);
    const page=await fetch('http://127.0.0.1:18794/api/projects');
    assert.equal(page.status,200);
    const state=await runAriadRuntimeCli(args('dashboard','status'));
    assert.equal(state.enabled,true);
    assert.equal(state.running,true);
    const stopped=await runAriadRuntimeCli(args('dashboard','stop'));
    assert.equal(stopped.enabled,false);
    assert.equal(stopped.running,false);
    const shutdown=await runAriadRuntimeCli(args('daemon','stop'));
    assert.equal(shutdown.stopping,true);
  } finally {
    try {
      const pidFile=path.join(root,'.runtime','ariad.pid');
      if(fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM');
    } catch {}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
