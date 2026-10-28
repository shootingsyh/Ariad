export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0d12">
<title>Ariad Project Explorer</title>
<style>
:root{
  color-scheme:dark;
  --bg:#0a0d12;--bg2:#0f141b;--panel:#131a22;--panel2:#18212b;--line:#283442;
  --text:#f2f6fa;--muted:#93a2b3;--accent:#7aa2f7;--accent2:#8bd5ca;
  --good:#8bd49c;--warn:#f6c177;--bad:#f28fad;--purple:#c6a0f6;
  --shadow:0 18px 60px rgba(0,0,0,.34);
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:linear-gradient(180deg,#0a0d12 0%,#0d1218 100%);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input{font:inherit}
button{color:inherit}
a{color:inherit}
.app{min-height:100vh}
.topbar{position:sticky;top:0;z-index:20;background:rgba(10,13,18,.88);backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}
.topbar-inner{max-width:1700px;margin:auto;padding:14px 22px;display:flex;align-items:center;gap:14px}
.brand{display:flex;align-items:center;gap:11px;min-width:0}
.logo{width:34px;height:34px;border-radius:11px;background:linear-gradient(145deg,#7aa2f7,#8bd5ca);box-shadow:0 8px 26px rgba(122,162,247,.22);position:relative}
.logo:after{content:"";position:absolute;inset:8px;border:2px solid rgba(10,13,18,.65);border-radius:7px;transform:rotate(45deg)}
.brand h1{font-size:17px;margin:0;letter-spacing:.2px}
.brand .sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top-actions{margin-left:auto;display:flex;gap:8px}
.btn{border:1px solid var(--line);background:#151d26;border-radius:10px;padding:8px 11px;cursor:pointer}
.btn:hover{border-color:#3d4e61;background:#1a2430}
.shell{max-width:1700px;margin:auto;padding:20px 22px 48px}
.project-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px}
.card{background:linear-gradient(180deg,rgba(22,29,38,.96),rgba(17,23,31,.96));border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.12)}
.project-card{padding:17px;cursor:pointer;transition:.18s ease}
.project-card:hover{transform:translateY(-2px);border-color:#405268;box-shadow:var(--shadow)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.small{font-size:12px}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:#202a35;border:1px solid #2d3947;font-size:11px;white-space:nowrap}
.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.RUNNING,.PLANNING,.READY,.WORKING{color:var(--accent)}
.SUCCEEDED,.DONE,.SATISFIED{color:var(--good)}
.FAILED,.NEEDS_HUMAN,.SYSTEM_BLOCKED,.NOT_PASS,.FAILED_CRITERION{color:var(--bad)}
.WAITING_REPLAN,.RESULT_READY{color:var(--warn)}
.IDLE,.STOPPED,.SKIPPED,.OBSOLETE{color:var(--muted)}
.metrics{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}
.metric b{display:block;font-size:18px;line-height:1.1}.metric span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.hidden{display:none!important}
.project-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:start;margin-bottom:14px}
.project-title{font-size:26px;line-height:1.15;margin:0 0 4px}
.project-goal{color:#c8d3df;max-width:980px}
.version-bar{display:flex;align-items:center;gap:8px;overflow:auto;padding:8px 0 14px;scrollbar-width:thin}
.version-pill{flex:0 0 auto;border:1px solid var(--line);background:#121922;color:var(--muted);border-radius:999px;padding:7px 11px;cursor:pointer}
.version-pill.active{color:var(--text);border-color:#5773a0;background:#192537;box-shadow:inset 0 0 0 1px rgba(122,162,247,.18)}
.version-pill .live{color:var(--accent2);margin-left:5px}
.view-tabs{display:flex;gap:6px;margin-bottom:14px}
.tab{border:0;background:transparent;color:var(--muted);padding:8px 12px;border-radius:9px;cursor:pointer}
.tab.active{background:#1a2430;color:var(--text)}
.explorer{display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:14px;align-items:start}
.canvas{min-height:620px;padding:16px;overflow:auto}
.canvas-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
.canvas-title{font-size:15px;font-weight:700}.canvas-sub{font-size:12px;color:var(--muted);margin-top:2px}
.tree{min-width:650px;padding:6px 4px 18px}
.tree-root-list{display:flex;flex-direction:column;gap:12px}
.tree-node-wrap{position:relative;margin-left:22px}
.tree-node-wrap.root{margin-left:0}
.tree-node-wrap:not(.root):before{content:"";position:absolute;left:-13px;top:-12px;bottom:18px;border-left:1px solid #304052}
.tree-node-wrap:not(.root):after{content:"";position:absolute;left:-13px;top:22px;width:12px;border-top:1px solid #304052}
.tree-node{position:relative;border:1px solid #2a3948;background:linear-gradient(180deg,#17212b,#121a22);border-radius:13px;padding:11px 12px;cursor:pointer;transition:.16s ease;max-width:850px}
.tree-node:hover{border-color:#4a6079;background:linear-gradient(180deg,#1b2835,#14202b)}
.tree-node.selected{border-color:var(--accent);box-shadow:0 0 0 1px rgba(122,162,247,.25),0 8px 28px rgba(0,0,0,.18)}
.node-top{display:flex;align-items:center;gap:8px}
.node-title{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.node-id{font-size:10px;color:var(--muted);margin-top:3px}
.node-summary{color:#bdc9d5;font-size:12px;margin-top:7px;max-width:760px}
.node-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chip{font-size:10px;padding:2px 6px;border:1px solid #314154;border-radius:999px;color:var(--muted);background:#10161d}
.chip.added{color:var(--good);border-color:rgba(139,212,156,.35)}
.chip.revised{color:var(--warn);border-color:rgba(246,193,119,.35)}
.chip.unchanged{color:var(--muted)}
.tree-children{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.detail{position:sticky;top:82px;max-height:calc(100vh - 104px);overflow:auto;padding:16px}
.detail-empty{display:grid;place-items:center;min-height:220px;text-align:center;color:var(--muted)}
.detail h2{font-size:18px;margin:0 0 3px}.detail h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:18px 0 8px}
.detail-row{display:grid;grid-template-columns:110px 1fr;gap:10px;padding:7px 0;border-bottom:1px solid rgba(40,52,66,.65)}
.detail-row:last-child{border-bottom:0}.detail-key{color:var(--muted);font-size:12px}.detail-value{word-break:break-word}
.list{margin:0;padding-left:18px}.list li{margin:4px 0}
.task-list{display:flex;flex-direction:column;gap:7px}
.task-item{padding:9px 10px;border:1px solid #2b3948;background:#10171e;border-radius:10px}
.task-item .title{font-size:12px;font-weight:700}.task-item .meta{font-size:10px;color:var(--muted);margin-top:2px}
.empty{padding:34px;text-align:center;color:var(--muted)}
.mobile-detail-close{display:none}
.overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.overview-card{padding:15px}.overview-card h3{margin:0 0 10px;font-size:13px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;color:var(--muted)}.kv b{color:var(--text)}
@media(max-width:900px){
  .topbar-inner{padding:12px 14px}.shell{padding:14px 12px 80px}
  .project-head{grid-template-columns:1fr}.project-title{font-size:22px}
  .explorer{grid-template-columns:1fr}.canvas{padding:12px;min-height:480px}
  .tree{min-width:0}.tree-node-wrap{margin-left:16px}.tree-node-wrap:not(.root):before{left:-10px}.tree-node-wrap:not(.root):after{left:-10px;width:9px}
  .detail{position:fixed;z-index:50;left:8px;right:8px;bottom:8px;top:auto;max-height:72vh;border-radius:18px;box-shadow:0 -20px 70px rgba(0,0,0,.55);transform:translateY(calc(100% + 24px));transition:transform .22s ease}
  .detail.open{transform:translateY(0)}
  .mobile-detail-close{display:block;float:right;border:1px solid var(--line);background:#19212b;border-radius:9px;padding:5px 9px;cursor:pointer}
  .node-summary{display:none}.node-title{font-size:13px}.node-meta{margin-top:6px}
  .brand .sub{display:none}
}
@media(max-width:520px){
  .top-actions .btn.secondary{display:none}.project-grid{grid-template-columns:1fr}
  .version-pill{padding:6px 10px}.view-tabs{overflow:auto}
  .canvas-head{align-items:center}.canvas-title{font-size:14px}
}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <div class="logo"></div>
        <div><h1>Ariad Project Explorer</h1><div class="sub">Feature trees, milestones, versions, and execution details</div></div>
      </div>
      <div class="top-actions">
        <button class="btn secondary hidden" id="allProjectsBtn">All projects</button>
        <button class="btn" id="refreshBtn">Refresh</button>
      </div>
    </div>
  </div>
  <main class="shell">
    <section id="projectList"><div id="projects" class="project-grid"></div></section>
    <section id="projectExplorer" class="hidden">
      <div class="project-head">
        <div>
          <h2 id="projectTitle" class="project-title"></h2>
          <div id="projectMeta" class="small muted mono"></div>
          <div id="projectGoal" class="project-goal"></div>
        </div>
        <div id="projectState"></div>
      </div>
      <div id="versions" class="version-bar"></div>
      <div class="view-tabs">
        <button class="tab active" data-view="feature">Feature Tree</button>
        <button class="tab" data-view="milestone">Milestone Tree</button>
        <button class="tab" data-view="overview">Overview</button>
      </div>
      <div class="explorer">
        <div id="canvas" class="card canvas"></div>
        <aside id="detail" class="card detail">
          <button class="mobile-detail-close" id="closeDetail">Close</button>
          <div id="detailContent" class="detail-empty">Select a feature or milestone to inspect its details.</div>
        </aside>
      </div>
    </section>
  </main>
</div>
<script>
(function(){
  var state={projectId:null,project:null,versions:[],version:null,data:null,view:'feature',selected:null,selectedKind:null};
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var badge=function(s){return '<span class="badge '+esc(s)+'">'+esc(s)+'</span>'};
  var metric=function(label,value){return '<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>'};
  async function getJson(url){var r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error(await r.text());return r.json()}
  function projectCard(x){
    return '<div class="card project-card" data-project="'+esc(x.project.id)+'">'+
      '<div class="row"><div><b>'+esc(x.project.name||x.project.id)+'</b><div class="small muted mono">'+esc(x.project.id)+'</div></div>'+badge(x.project.executionState)+'</div>'+
      '<div class="muted" style="margin-top:10px">'+esc(x.project.goal||'No goal')+'</div>'+
      '<div class="metrics">'+metric('done',x.summary.done)+metric('working',x.summary.working)+metric('ready',x.summary.ready)+metric('blocked',x.summary.systemBlocked)+'</div>'+
    '</div>';
  }
  async function loadProjects(){
    var items=await getJson('/api/projects');
    var el=document.getElementById('projects');
    el.innerHTML=items.length?items.map(projectCard).join(''):'<div class="card empty">No Ariad projects yet.</div>';
    Array.from(el.querySelectorAll('[data-project]')).forEach(function(node){node.onclick=function(){openProject(node.getAttribute('data-project'))}});
  }
  async function openProject(id){
    state.projectId=id;state.selected=null;state.selectedKind=null;
    document.getElementById('projectList').classList.add('hidden');
    document.getElementById('projectExplorer').classList.remove('hidden');
    document.getElementById('allProjectsBtn').classList.remove('hidden');
    var base=await getJson('/api/projects/'+encodeURIComponent(id));
    state.project=base;
    document.getElementById('projectTitle').textContent=base.project.name||base.project.id;
    document.getElementById('projectMeta').textContent=base.project.id+' · '+(base.project.mode||'NEW');
    document.getElementById('projectGoal').textContent=base.project.goal||'No goal';
    document.getElementById('projectState').innerHTML=badge(base.project.executionState);
    state.versions=await getJson('/api/projects/'+encodeURIComponent(id)+'/versions');
    renderVersions();
    var preferred=state.versions.find(function(v){return v.current})||state.versions[state.versions.length-1];
    if(preferred)await selectVersion(preferred.version);
    else renderCanvas();
  }
  function renderVersions(){
    var el=document.getElementById('versions');
    el.innerHTML=state.versions.map(function(v){
      var active=Number(v.version)===Number(state.version)?' active':'';
      var live=v.current?'<span class="live">current</span>':'';
      return '<button class="version-pill'+active+'" data-version="'+esc(v.version)+'">v'+esc(v.version)+live+'</button>';
    }).join('');
    Array.from(el.querySelectorAll('[data-version]')).forEach(function(node){node.onclick=function(){selectVersion(Number(node.getAttribute('data-version')))}});
  }
  async function selectVersion(version){
    state.version=version;state.selected=null;state.selectedKind=null;
    state.data=await getJson('/api/projects/'+encodeURIComponent(state.projectId)+'/versions/'+encodeURIComponent(version));
    renderVersions();renderCanvas();renderDetail();
  }
  function childrenMap(items){
    var map=new Map();items.forEach(function(item){var p=item.parentId||null;if(!map.has(p))map.set(p,[]);map.get(p).push(item)});
    map.forEach(function(arr){arr.sort(function(a,b){return String(a.id).localeCompare(String(b.id))})});
    return map;
  }
  function revisionChip(node){
    var kind=node.revision&&node.revision.kind;
    return kind?'<span class="chip '+esc(kind)+'">'+esc(kind)+'</span>':'';
  }
  function taskStatsForLogical(id){
    var tasks=(state.data&&state.data.tasks)||[];
    var linked=tasks.filter(function(t){return Array.isArray(t.logicalRefs)&&t.logicalRefs.indexOf(id)>=0});
    var done=linked.filter(function(t){return t.state==='DONE'}).length;
    return linked.length?'<span class="chip">'+done+'/'+linked.length+' tasks done</span>':'';
  }
  function milestoneStats(id){
    var tasks=(state.data&&state.data.tasks)||[];
    var linked=tasks.filter(function(t){return t.milestoneId===id});
    var done=linked.filter(function(t){return t.state==='DONE'}).length;
    return linked.length?'<span class="chip">'+done+'/'+linked.length+' tasks done</span>':'';
  }
  function renderNode(node,kind,map,root){
    var kids=map.get(node.id)||[];
    var selected=state.selectedKind===kind&&state.selected===node.id?' selected':'';
    var summary=kind==='feature'?(node.summary||''):(node.goal||node.summary||'');
    var extra=kind==='feature'?revisionChip(node)+taskStatsForLogical(node.id):milestoneStats(node.id)+(node.dependsOn&&node.dependsOn.length?'<span class="chip">depends '+esc(node.dependsOn.length)+'</span>':'');
    return '<div class="tree-node-wrap'+(root?' root':'')+'">'+
      '<div class="tree-node'+selected+'" data-kind="'+kind+'" data-id="'+esc(node.id)+'">'+
        '<div class="node-top"><div class="node-title">'+esc(node.title||node.id)+'</div></div>'+
        '<div class="node-id mono">'+esc(node.id)+'</div>'+
        (summary?'<div class="node-summary">'+esc(summary)+'</div>':'')+
        '<div class="node-meta">'+extra+'</div>'+
      '</div>'+
      (kids.length?'<div class="tree-children">'+kids.map(function(k){return renderNode(k,kind,map,false)}).join('')+'</div>':'')+
    '</div>';
  }
  function treeHtml(items,kind){
    if(!items||!items.length)return '<div class="empty">No '+(kind==='feature'?'feature':'milestone')+' tree is available for this version.</div>';
    var map=childrenMap(items);
    var ids=new Set(items.map(function(x){return x.id}));
    var roots=items.filter(function(x){return !x.parentId||!ids.has(x.parentId)});
    return '<div class="tree"><div class="tree-root-list">'+roots.map(function(r){return renderNode(r,kind,map,true)}).join('')+'</div></div>';
  }
  function renderCanvas(){
    var canvas=document.getElementById('canvas');
    if(!state.data){canvas.innerHTML='<div class="empty">No version data yet.</div>';return}
    if(state.view==='overview'){
      var d=state.data;
      var done=(d.tasks||[]).filter(function(t){return t.state==='DONE'}).length;
      var active=(d.tasks||[]).filter(function(t){return ['READY','WORKING','RESULT_READY','WAITING_REPLAN'].indexOf(t.state)>=0}).length;
      canvas.innerHTML='<div class="canvas-head"><div><div class="canvas-title">Version v'+esc(d.version)+'</div><div class="canvas-sub">'+esc(d.sourceLabel||'project state')+'</div></div></div>'+
        '<div class="overview-grid">'+
          '<div class="card overview-card"><h3>Structure</h3><div class="kv"><span>Features</span><b>'+esc((d.logicalNodes||[]).length)+'</b></div><div class="kv"><span>Milestones</span><b>'+esc((d.milestones||[]).length)+'</b></div><div class="kv"><span>Tasks</span><b>'+esc((d.tasks||[]).length)+'</b></div></div>'+
          '<div class="card overview-card"><h3>Execution</h3><div class="kv"><span>Done</span><b>'+done+'</b></div><div class="kv"><span>Active</span><b>'+active+'</b></div><div class="kv"><span>Plan version</span><b>'+esc(d.deliveryPlanVersion==null?'—':d.deliveryPlanVersion)+'</b></div></div>'+
          '<div class="card overview-card"><h3>Snapshot</h3><div class="kv"><span>Captured</span><b>'+esc(d.capturedAt||'live')+'</b></div><div class="kv"><span>Root feature</span><b class="mono">'+esc(d.logicalRootId||'—')+'</b></div></div>'+
        '</div>';
      return;
    }
    var items=state.view==='feature'?state.data.logicalNodes:state.data.milestones;
    var title=state.view==='feature'?'Feature Tree':'Milestone Tree';
    var sub=state.view==='feature'?'Product capability hierarchy for this version.':'Delivery milestone hierarchy; click a milestone to inspect its tasks and dependencies.';
    canvas.innerHTML='<div class="canvas-head"><div><div class="canvas-title">'+title+' · v'+esc(state.data.version)+'</div><div class="canvas-sub">'+sub+'</div></div><div class="small muted">'+esc(items.length)+' nodes</div></div>'+treeHtml(items,state.view);
    Array.from(canvas.querySelectorAll('.tree-node[data-kind]')).forEach(function(node){
      node.onclick=function(e){e.stopPropagation();state.selectedKind=node.getAttribute('data-kind');state.selected=node.getAttribute('data-id');renderCanvas();renderDetail();if(window.innerWidth<=900)document.getElementById('detail').classList.add('open')};
    });
  }
  function row(k,v){return '<div class="detail-row"><div class="detail-key">'+esc(k)+'</div><div class="detail-value">'+v+'</div></div>'}
  function list(values){return values&&values.length?'<ul class="list">'+values.map(function(v){return '<li>'+esc(typeof v==='string'?v:JSON.stringify(v))+'</li>'}).join('')+'</ul>':'<span class="muted">None</span>'}
  function linkedTasks(kind,id){
    var tasks=(state.data&&state.data.tasks)||[];
    return kind==='feature'?tasks.filter(function(t){return Array.isArray(t.logicalRefs)&&t.logicalRefs.indexOf(id)>=0}):tasks.filter(function(t){return t.milestoneId===id});
  }
  function renderDetail(){
    var el=document.getElementById('detailContent');
    if(!state.selected||!state.data){el.className='detail-empty';el.innerHTML='Select a feature or milestone to inspect its details.';return}
    var items=state.selectedKind==='feature'?state.data.logicalNodes:state.data.milestones;
    var node=items.find(function(x){return x.id===state.selected});
    if(!node){el.className='detail-empty';el.innerHTML='The selected node is not present in this version.';return}
    var tasks=linkedTasks(state.selectedKind,node.id);
    var body='<h2>'+esc(node.title||node.id)+'</h2><div class="small muted mono">'+esc(node.id)+'</div>';
    if(state.selectedKind==='feature'){
      body+= '<h3>Feature</h3>'+
        row('Summary',esc(node.summary||'—'))+
        row('Parent',esc(node.parentId||'Root'))+
        (node.revision?row('Revision',esc(node.revision.kind)+' · '+esc(node.revision.reason||'')):'');
    }else{
      body+='<h3>Milestone</h3>'+
        row('Goal',esc(node.goal||node.summary||'—'))+
        row('Parent',esc(node.parentId||'Root'))+
        row('Depends on',list(node.dependsOn||[]))+
        row('Logical refs',list(node.logicalRefs||[]))+
        row('Acceptance',list(node.acceptanceCriteria||[]))+
        row('Test strategy',esc(node.testStrategy||'—'));
    }
    body+='<h3>Linked tasks · '+tasks.length+'</h3><div class="task-list">'+(tasks.length?tasks.map(function(t){
      return '<div class="task-item"><div class="row"><div class="title">'+esc(t.title||t.id)+'</div>'+badge(t.state)+'</div><div class="meta mono">'+esc(t.id)+' · '+esc(t.stage)+'</div></div>';
    }).join(''):'<div class="muted small">No tasks linked to this node.</div>')+'</div>';
    el.className='';el.innerHTML=body;
  }
  function setView(view){
    state.view=view;state.selected=null;state.selectedKind=null;
    Array.from(document.querySelectorAll('.tab')).forEach(function(t){t.classList.toggle('active',t.getAttribute('data-view')===view)});
    renderCanvas();renderDetail();document.getElementById('detail').classList.remove('open');
  }
  async function refresh(){
    if(state.projectId){await openProject(state.projectId);if(state.version&&state.versions.some(function(v){return v.version===state.version}))await selectVersion(state.version)}
    else await loadProjects();
  }
  document.getElementById('refreshBtn').onclick=function(){refresh().catch(console.error)};
  document.getElementById('allProjectsBtn').onclick=function(){state.projectId=null;state.data=null;document.getElementById('projectExplorer').classList.add('hidden');document.getElementById('projectList').classList.remove('hidden');document.getElementById('allProjectsBtn').classList.add('hidden');loadProjects().catch(console.error)};
  document.getElementById('closeDetail').onclick=function(){document.getElementById('detail').classList.remove('open')};
  Array.from(document.querySelectorAll('.tab')).forEach(function(t){t.onclick=function(){setView(t.getAttribute('data-view'))}});
  loadProjects().catch(function(e){document.getElementById('projects').innerHTML='<div class="card empty">'+esc(e.message)+'</div>'});
})();
</script>
</body>
</html>`;
}
