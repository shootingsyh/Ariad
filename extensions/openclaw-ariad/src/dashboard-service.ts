import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type ProjectManager = {
  list(): any[];
  status(name: string): any;
};

function decode(value: unknown) {
  return value == null ? null : JSON.parse(String(value));
}

function json(res: any, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function html(res: any, body: string) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function summarizeTasks(tasks: any[]) {
  const count = (state: string) => tasks.filter(task => task.state === state).length;
  return {
    total: tasks.length,
    ready: count('READY'),
    working: count('WORKING'),
    resultReady: count('RESULT_READY'),
    waitingReplan: count('WAITING_REPLAN'),
    needsHuman: count('NEEDS_HUMAN'),
    systemBlocked: count('SYSTEM_BLOCKED'),
    done: count('DONE'),
    skipped: count('SKIPPED'),
    obsolete: count('OBSOLETE'),
  };
}

function readProjectDb(project: any) {
  if (!project.stateDb || !existsSync(project.stateDb)) {
    return { tasks: [], planning: [], incidents: [], runtimeProject: null };
  }

  const db = new DatabaseSync(project.stateDb, { readOnly: true });
  try {
    const tableRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v2_%'"
    ).all() as any[];
    const tables = new Set(tableRows.map(row => row.name));

    const runtimeProject = tables.has('v2_projects')
      ? db.prepare('SELECT id, data_json, version, updated_at FROM v2_projects WHERE id = ?').get(project.id) as any
      : null;

    const tasks = tables.has('v2_tasks')
      ? (db.prepare('SELECT id, project_id, data_json, version, updated_at FROM v2_tasks WHERE project_id = ? ORDER BY rowid')
          .all(project.id) as any[])
          .map(row => ({
            ...decode(row.data_json),
            id: row.id,
            projectId: row.project_id,
            version: row.version,
            updatedAt: row.updated_at,
          }))
      : [];

    const planning = tables.has('v2_planning_requests')
      ? (db.prepare(
          'SELECT sequence, id, project_id, state, batch_id, data_json, created_at, updated_at FROM v2_planning_requests WHERE project_id = ? ORDER BY sequence'
        ).all(project.id) as any[]).map(row => ({
          ...decode(row.data_json),
          sequence: row.sequence,
          id: row.id,
          projectId: row.project_id,
          state: row.state,
          batchId: row.batch_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }))
      : [];

    const incidents = tables.has('v2_system_incidents')
      ? (db.prepare(
          'SELECT sequence, task_id, data_json, created_at FROM v2_system_incidents WHERE project_id = ? ORDER BY sequence DESC LIMIT 100'
        ).all(project.id) as any[]).map(row => ({
          sequence: row.sequence,
          taskId: row.task_id,
          ...decode(row.data_json),
          createdAt: row.created_at,
        }))
      : [];

    return {
      runtimeProject: runtimeProject
        ? {
            ...decode(runtimeProject.data_json),
            id: runtimeProject.id,
            version: runtimeProject.version,
            updatedAt: runtimeProject.updated_at,
          }
        : null,
      tasks,
      planning,
      incidents,
    };
  } finally {
    db.close();
  }
}

function projectView(manager: ProjectManager, name: string) {
  const project = manager.status(name);
  const db = readProjectDb(project);
  const activeTasks = db.tasks.filter((task: any) =>
    !['DONE', 'SKIPPED', 'OBSOLETE'].includes(task.state)
  );
  return {
    project,
    runtimeProject: db.runtimeProject,
    summary: summarizeTasks(db.tasks),
    planningSummary: {
      pending: db.planning.filter((item: any) => item.state === 'PENDING').length,
      claimed: db.planning.filter((item: any) => item.state === 'CLAIMED').length,
      planned: db.planning.filter((item: any) => item.state === 'PLANNED').length,
    },
    activeTasks,
    tasks: db.tasks,
    planning: db.planning,
    incidents: db.incidents,
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ariad Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--panel:#14181d;--muted:#8f9ba8;--text:#eef3f7;--line:#26303a;--good:#7bd88f;--warn:#ffd166;--bad:#ff6b6b;--accent:#7aa2f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{position:sticky;top:0;background:#0b0d10e8;backdrop-filter:blur(12px);border-bottom:1px solid var(--line);padding:18px 24px;z-index:3}
h1,h2,h3{margin:0}.sub{color:var(--muted);margin-top:4px}.wrap{padding:20px 24px 50px;max-width:1500px;margin:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.card.clickable{cursor:pointer}.card.clickable:hover{border-color:#43515f}.row{display:flex;gap:10px;align-items:center;justify-content:space-between}.muted{color:var(--muted)}
.badge{padding:3px 8px;border-radius:999px;background:#222a32;font-size:12px}.RUNNING,.PLANNING{color:var(--accent)}.SUCCEEDED,.DONE{color:var(--good)}.FAILED,.NEEDS_HUMAN,.SYSTEM_BLOCKED{color:var(--bad)}.IDLE,.STOPPED{color:var(--muted)}
.metrics{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}.metric b{font-size:18px}.metric span{display:block;color:var(--muted);font-size:11px}
.toolbar{display:flex;gap:8px;margin:0 0 16px}.btn{background:#1c232b;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 10px;cursor:pointer}
section{margin-top:20px}.task{border-left:2px solid var(--line);padding:8px 10px;margin:6px 0 6px 12px;background:#11151a;border-radius:0 8px 8px 0}.task-title{display:flex;justify-content:space-between;gap:10px}.small{font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{white-space:pre-wrap;word-break:break-word;background:#0d1116;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:320px;overflow:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
#detail{display:none}.empty{padding:30px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<header><h1>Ariad Dashboard</h1><div class="sub">Read-only live view of projects, planning, execution, and incidents.</div></header>
<div class="wrap">
  <div id="listView"><div id="projects" class="grid"></div></div>
  <div id="detail">
    <div class="toolbar"><button class="btn" onclick="showList()">← All projects</button><button class="btn" onclick="refresh()">Refresh</button></div>
    <div id="projectDetail"></div>
  </div>
</div>
<script>
let selected = null;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = s => '<span class="badge '+esc(s)+'">'+esc(s)+'</span>';
function showList(){selected=null;document.getElementById('detail').style.display='none';document.getElementById('listView').style.display='block';refresh()}
function openProject(id){selected=id;document.getElementById('listView').style.display='none';document.getElementById('detail').style.display='block';refresh()}
function metric(label,value){return '<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>'}
async function loadJson(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error(await r.text());return r.json()}
function renderProjects(items){
  const el=document.getElementById('projects');
  if(!items.length){el.innerHTML='<div class="empty">No Ariad projects yet.</div>';return}
  el.innerHTML=items.map(x=>'<div class="card clickable" onclick="openProject(\''+esc(x.project.id)+'\')">'+
    '<div class="row"><h3>'+esc(x.project.name||x.project.id)+'</h3>'+badge(x.project.executionState)+'</div>'+
    '<div class="muted small mono">'+esc(x.project.id)+'</div>'+
    '<div class="muted" style="margin-top:8px">'+esc(x.project.goal||'No goal')+'</div>'+
    '<div class="metrics">'+metric('done',x.summary.done)+' '+metric('working',x.summary.working)+' '+metric('ready',x.summary.ready)+' '+metric('needs human',x.summary.needsHuman)+' '+metric('incidents',x.incidentCount)+'</div>'+
    '</div>').join('');
}
function renderTask(task, children){
  const kids=children.get(task.id)||[];
  const deps=(task.dependsOn||[]).length?' · deps: '+task.dependsOn.join(', '):'';
  const execution=task.execution?.role?' · '+task.execution.role:'';
  return '<div class="task"><div class="task-title"><b>'+esc(task.title||task.id)+'</b>'+badge(task.state)+'</div>'+
    '<div class="small muted mono">'+esc(task.id)+' · '+esc(task.stage)+esc(execution)+esc(deps)+'</div>'+
    (task.intent?'<div class="small" style="margin-top:4px">'+esc(task.intent)+'</div>':'')+
    kids.map(k=>renderTask(k,children)).join('')+'</div>';
}
function renderTree(tasks){
  const delivery=tasks.filter(t=>t.scope==='delivery');
  const children=new Map();delivery.forEach(t=>{if(t.parentId){const a=children.get(t.parentId)||[];a.push(t);children.set(t.parentId,a)}});
  const roots=delivery.filter(t=>!t.parentId||!delivery.some(x=>x.id===t.parentId));
  return roots.length?roots.map(r=>renderTask(r,children)).join(''):'<div class="empty">No delivery plan yet.</div>';
}
function renderDetail(x){
  const p=x.project,s=x.summary;
  const active=x.activeTasks.length?x.activeTasks.map(t=>'<tr><td class="mono">'+esc(t.id)+'</td><td>'+esc(t.stage)+'</td><td>'+badge(t.state)+'</td><td class="small">'+esc(t.execution?.role||'')+'</td></tr>').join(''):'<tr><td colspan="4" class="muted">No active tasks</td></tr>';
  const planning=x.planning.slice().reverse().map(r=>'<tr><td>'+esc(r.sequence)+'</td><td class="mono">'+esc(r.id)+'</td><td>'+badge(r.state)+'</td><td>'+esc(r.batchId||'')+'</td><td class="small">'+esc(typeof r.request==='string'?r.request:JSON.stringify(r.request))+'</td></tr>').join('');
  const incidents=x.incidents.map(i=>'<tr><td>'+esc(i.sequence)+'</td><td class="mono">'+esc(i.taskId||'')+'</td><td>'+esc(i.type||i.reason||'incident')+'</td><td class="small">'+esc(i.createdAt||i.at||'')+'</td></tr>').join('');
  document.getElementById('projectDetail').innerHTML=
    '<div class="card"><div class="row"><div><h2>'+esc(p.name||p.id)+'</h2><div class="muted mono">'+esc(p.id)+'</div></div>'+badge(p.executionState)+'</div>'+
    '<div style="margin-top:10px">'+esc(p.goal||'No goal')+'</div>'+
    '<div class="metrics">'+metric('total',s.total)+metric('done',s.done)+metric('working',s.working)+metric('ready',s.ready)+metric('needs human',s.needsHuman)+metric('blocked',s.systemBlocked)+'</div>'+
    '<div class="small muted" style="margin-top:10px">Frontdesk: '+esc(p.frontdeskBinding?.sessionKey||'unbound')+'</div></div>'+
    '<section><h3>Active execution</h3><div class="card"><table><thead><tr><th>Task</th><th>Stage</th><th>State</th><th>Role</th></tr></thead><tbody>'+active+'</tbody></table></div></section>'+
    '<section><h3>Delivery tree</h3><div class="card">'+renderTree(x.tasks)+'</div></section>'+
    '<section><h3>Planning queue</h3><div class="card"><table><thead><tr><th>#</th><th>Request</th><th>State</th><th>Batch</th><th>Purpose</th></tr></thead><tbody>'+(planning||'<tr><td colspan="5" class="muted">No planning requests</td></tr>')+'</tbody></table></div></section>'+
    '<section><h3>System incidents</h3><div class="card"><table><thead><tr><th>#</th><th>Task</th><th>Type</th><th>Time</th></tr></thead><tbody>'+(incidents||'<tr><td colspan="4" class="muted">No incidents</td></tr>')+'</tbody></table></div></section>'+
    '<section><h3>Workspace</h3><div class="card small mono">'+esc(p.workspace)+'</div></section>';
}
async function refresh(){
  try{
    if(selected){renderDetail(await loadJson('/api/projects/'+encodeURIComponent(selected)))}
    else{renderProjects(await loadJson('/api/projects'))}
  }catch(e){console.error(e)}
}
refresh();setInterval(refresh,2000);
</script>
</body></html>`;
}

export class AriadDashboardService {
  private readonly manager: ProjectManager;
  private readonly host: string;
  private readonly port: number;
  private readonly logger: any;
  private server: Server | null = null;

  constructor({
    manager,
    host = '127.0.0.1',
    port = 18791,
    logger,
  }: {
    manager: ProjectManager;
    host?: string;
    port?: number;
    logger?: any;
  }) {
    this.manager = manager;
    this.host = host;
    this.port = port;
    this.logger = logger;
  }

  async start() {
    if (this.server) return;
    this.server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method !== 'GET') {
          json(res, 405, { error: 'read-only dashboard' });
          return;
        }
        if (url.pathname === '/api/projects') {
          const projects = this.manager.list().map(project => {
            const db = readProjectDb(project);
            return {
              project,
              summary: summarizeTasks(db.tasks),
              planningSummary: {
                pending: db.planning.filter((item: any) => item.state === 'PENDING').length,
                claimed: db.planning.filter((item: any) => item.state === 'CLAIMED').length,
                planned: db.planning.filter((item: any) => item.state === 'PLANNED').length,
              },
              incidentCount: db.incidents.length,
            };
          });
          json(res, 200, projects);
          return;
        }
        if (url.pathname.startsWith('/api/projects/')) {
          const id = decodeURIComponent(url.pathname.slice('/api/projects/'.length));
          json(res, 200, projectView(this.manager, id));
          return;
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
          html(res, dashboardHtml());
          return;
        }
        json(res, 404, { error: 'not found' });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
    this.logger?.info?.(`Ariad dashboard listening on http://${this.host}:${this.port}`);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  get address() {
    const address = this.server?.address();
    return address && typeof address === 'object'
      ? { host: this.host, port: address.port }
      : null;
  }

  get url() {
    const address = this.address;
    return address ? `http://${address.host}:${address.port}` : `http://${this.host}:${this.port}`;
  }
}
