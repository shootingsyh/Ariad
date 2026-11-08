import { Type } from 'typebox';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { ProjectMemoryStore } from './project-memory.js';
import { codeSearch, interfaceSearch } from './project-search-tools.js';
import { searchWeb, fetchWebPage } from './web-research.js';
import { queryInterfaces } from '../v2/interface-query.js';
import { VersionedStore } from '../v2/versioned-store.js';
import { issueAnchor } from '../v2/interface-seal.js';
import { sessionHistory } from './session-history.js';

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export const ARIAD_PROJECT_TOOL_NAMES = Object.freeze([
  'ariad_code_search',
  'ariad_interface_search',
  'ariad_interface_contract', 'ariad_anchor_lookup',
  'ariad_document_symbols', 'ariad_definition', 'ariad_references', 'ariad_workspace_symbols', 'ariad_call_graph',
  'ariad_memory_search',
  'ariad_memory_write',
  'ariad_session_history',
  'ariad_report_issue',
  'ariad_insert_fix_task',
  'ariad_tree_patch',
  'ariad_web_search', 'ariad_web_fetch',
]);

export function registerAriadProjectTools(pi, { workspace, projectStoreFile = null, reportIssue = null, insertTriagedFixTask = null, requestPlanning = null, taskContext = null, codeIntelligence = null }) {
  const resolveFile = file => {
    const path = resolve(workspace, file);
    if (relative(workspace, path).startsWith('..') || (isAbsolute(file) && !path.startsWith(workspace + '/'))) throw new Error('FILE_OUTSIDE_WORKSPACE');
    // Ariad state protection (2026-11-03 incident): Ariad's own file
    // tools must never resolve a project state database under .ariad/
    // (any *.db / *.db-wal / *.db-shm / *.db-journal). A role session
    // edited one as a binary file and zeroed the planning store.
    const rel = relative(workspace, path).split('\\').join('/');
    const base = rel.split('/').pop() ?? '';
    if ((rel === '.ariad' || rel.startsWith('.ariad/')) && /\.db(?:-wal|-shm|-journal)?$/i.test(base)) {
      throw new Error(`PROTECTED_ARIAD_STATE: ${rel} is an Ariad state database and is never a file-tool target; use the Ariad tools (ariad_tree_patch for the spec tree) instead`);
    }
    return path;
  };
  // The project's language server belongs to the project runtime and
  // shares the project's lifecycle: sessions only use it - they never
  // start one of their own and never shut it down. (Per-session editor
  // processes leaked for days before this: every session spawned a godot
  // editor that nothing ever reaped.)
  const languageServer = () => {
    if (!codeIntelligence) {
      throw new Error('LSP_UNAVAILABLE: no project language server is attached to this session (the project runtime owns it)');
    }
    return codeIntelligence;
  };
  const addTool = (name, description, parameters, run) => pi.registerTool({
    name, label: name, description, parameters,
    async execute(_id, args) { return textResult(await run(args)); },
  });
  addTool('ariad_document_symbols', 'List GDScript functions, classes and variables with locations without reading the entire file.', Type.Object({file: Type.String()}), async ({file}) => ({symbols: await languageServer().documentSymbols(resolveFile(file))}));
  addTool('ariad_definition', 'Resolve a GDScript symbol definition at zero-based line and character.', Type.Object({file:Type.String(),line:Type.Integer({minimum:0}),character:Type.Optional(Type.Integer({minimum:0}))}), async ({file,line,character}) => ({definitions: await languageServer().definition(resolveFile(file),line,character??0)}));
  addTool('ariad_references', 'Find references to a GDScript symbol at zero-based line and character.', Type.Object({file:Type.String(),line:Type.Integer({minimum:0}),character:Type.Optional(Type.Integer({minimum:0}))}), async ({file,line,character}) => ({references: await languageServer().references(resolveFile(file),line,character??0)}));
  addTool('ariad_workspace_symbols', 'Search GDScript symbols across the workspace.', Type.Object({query:Type.String()}), async ({query}) => ({symbols: await languageServer().workspaceSymbols(query)}));
  addTool('ariad_call_graph', 'Best-effort static direct/recursive GDScript call graph. Dynamic calls and signals may be unresolved; do not treat this as exhaustive. Depth defaults to 1.', Type.Object({file:Type.String(),symbol:Type.String(),depth:Type.Optional(Type.Integer({minimum:1,maximum:4}))}), async ({file,symbol,depth=1}) => {
    const source=readFileSync(resolveFile(file),'utf8').split(/\r?\n/);
    const funcs=new Map();let current=null;
    for(let i=0;i<source.length;i++){
      const match=source[i].match(/^(?:static\s+)?func\s+([\w]+)\s*\(/);
      if(match){current={name:match[1],line:i+1,body:[]};funcs.set(match[1],current);}
      else if(current && source[i].match(/^(?:func|class|signal|enum|const|var|@)/))current=null;
      else if(current)current.body.push(source[i].replace(/#.*$/,''));
    }
    const visit=(name,remaining,seen)=>{
      const fn=funcs.get(name);if(!fn)return {symbol:name,resolved:false};
      const calls=[...new Set([...fn.body.join('\n').matchAll(/(?<![\w])([a-zA-Z_]\w*)\s*\(/g)].map(m=>m[1]).filter(n=>!['if','while','for','match','return','await','print','assert'].includes(n)))];
      return {symbol:name,line:fn.line,calls:calls.map(n=>({symbol:n,local:funcs.has(n),...(remaining>1 && funcs.has(n) && !seen.has(n)?{graph:visit(n,remaining-1,new Set([...seen,n]))}:{})})),limitations:['regex-based best-effort; dynamic calls, inherited functions, signals and cross-file targets are not resolved']};
    };
    return visit(symbol,depth,new Set([symbol]));
  });

  pi.registerTool({
    name: 'ariad_code_search',
    label: 'Ariad code search',
    description: 'Search the live project repository for code, symbols, strings, or patterns. Results are read directly from the current workspace, so they do not become stale.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      mode: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('symbol')])),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      return textResult({ hits: codeSearch(workspace, params.query, {
        limit: params.limit ?? 40,
        mode: params.mode ?? 'text',
      }) });
    },
  });

  addTool('ariad_web_search', 'Search the public web for external references, benchmarks and prior art (no API key; Bilibili video search primary - results carry thumbnail image URLs - Sogou web search as fallback). Returns results with title, URL and snippet. An empty result set means the search found nothing usable - report that honestly instead of inventing sources.', Type.Object({query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))}), async ({query, limit}) => searchWeb(query, { limit: limit ?? 8 }));

  addTool('ariad_web_fetch', 'Fetch one web page for research: returns the page title, readable text (truncated) and the page image URLs, so visual references can be cited by URL. A binary image URL returns a citation note instead of content.', Type.Object({url: Type.String({ minLength: 1 })}), async ({url}) => fetchWebPage(url));

  pi.registerTool({
    name: 'ariad_interface_search',
    label: 'Ariad interface search',
    description: 'Search current Ariad planner interface artifacts, including contracts, imports, realization anchors, and verification anchors.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      return textResult({ hits: interfaceSearch(workspace, params.query, { limit: params.limit ?? 20 }) });
    },
  });

  pi.registerTool({
    name: 'ariad_interface_contract',
    label: 'Ariad interface contract',
    description: 'Resolve an interfaceId to its exact boundary contract: owning node, kind, visibility, contract terms, verification sketch, and which nodes import it. Omit interfaceId to list every interface in the project. Use this instead of searching files for interface contracts.',
    parameters: Type.Object({
      interfaceId: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      return textResult(queryInterfaces(join(workspace, '.ariad', 'artifacts'), { interfaceId: params.interfaceId ?? null }));
    },
  });

  addTool('ariad_anchor_lookup',
    'Get ready-to-submit interface seal anchors, resolved and hash-pinned against the live workspace. Pass a symbol (optionally with its file), or a file with startLine/endLine for a range anchor. Paste the returned anchors verbatim into result.interfaceRealizations / result.interfaceVerifications; never hand-write seal anchors from memory.',
    Type.Object({
      symbol: Type.Optional(Type.String({ minLength: 1 })),
      file: Type.Optional(Type.String({ minLength: 1 })),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),
    async (params) => {
      const anchors = [];
      const unresolved = [];
      const attempt = (anchor) => {
        const issued = issueAnchor({ workspace, anchor });
        if (issued.ok) anchors.push(issued.anchor);
        else unresolved.push({ ...anchor, reason: issued.reason });
      };
      if (params.file) resolveFile(params.file);
      if (params.file && Number.isInteger(params.startLine) && Number.isInteger(params.endLine)) {
        attempt({ kind: 'range', file: params.file, startLine: params.startLine, endLine: params.endLine });
      } else if (params.symbol && params.file) {
        attempt({ kind: 'symbol', file: params.file, symbol: params.symbol });
      } else if (params.symbol) {
        const hits = codeSearch(workspace, params.symbol, { limit: 20, mode: 'symbol' });
        const files = [...new Set(hits.map(hit => hit.file).filter(Boolean))].slice(0, 20);
        if (!files.length) unresolved.push({ kind: 'symbol', symbol: params.symbol, reason: 'NO_CANDIDATE_FILES' });
        for (const file of files) attempt({ kind: 'symbol', file, symbol: params.symbol });
      } else {
        throw new Error('ariad_anchor_lookup requires a symbol, or a file with startLine and endLine');
      }
      return { anchors, unresolved };
    });

  pi.registerTool({
    name: 'ariad_memory_search',
    label: 'Ariad project memory search',
    description: 'Search concise project memories. Filter by an attached artifact such as feature, task, interface, file, or symbol when known.',
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      artifactType: Type.Optional(Type.String()),
      artifactId: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const store = new ProjectMemoryStore(workspace);
      try {
        return textResult({ memories: store.search(params) });
      } finally {
        store.close();
      }
    },
  });


  pi.registerTool({
    name: 'ariad_session_history',
    label: 'Ariad session history',
    description: 'Read recent persisted Pi session history for this project. Use this for memory curation or historical debugging; it does not modify memory.',
    parameters: Type.Object({
      sinceHours: Type.Optional(Type.Number({ minimum: 0, maximum: 720 })),
      role: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 100000 })),
      includeMaintenance: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      return textResult({ events: sessionHistory(workspace, params) });
    },
  });

  let treeStore = null;
  const resolveTreeStoreFile = () => {
    if (projectStoreFile) return projectStoreFile;
    try {
      const manifest = JSON.parse(readFileSync(join(workspace, '.ariad', 'project.json'), 'utf8'));
      if (manifest?.dbFile) return join(workspace, '.ariad', manifest.dbFile);
    } catch { /* no readable manifest: historical default below */ }
    return join(workspace, '.ariad', 'state.db');
  };
  const openTreeStore = () => {
    if (!treeStore) {
      treeStore = new VersionedStore(resolveTreeStoreFile());
      if (!treeStore.projectId) treeStore.initProject(taskContext?.projectId ?? 'project');
    }
    return treeStore;
  };

  addTool('ariad_tree_patch',
    'Tech Lead only. DB-first planning: author the task tree and boundary contracts in the open DRAFT version of the project database (state.db) with structured operations; nothing here touches the production version or the running delivery queue. Actions: "openDraft" (start a new draft copied from prod; fails if one is already open; returns protectedTasks - never upsert or remove those tasks), "openRevisionDraft" (PM revision batches only: mint the NEXT version from the open PM-rejected draft - the rejected version is closed as superseded with its content retained and a new draft seeded from it becomes the open draft; fails with NOT_A_REVISION_BASE when the open draft is not the named revision base, e.g. the revision draft for this batch is already open - then continue it with applyOps), "applyOps" (ops: {op:"upsertTask",task} / {op:"removeTask",taskId} / {op:"upsertContract",contract} / {op:"removeContract",contractId}; the whole draft is validated after each call - dependency existence and acyclicity, contract behavior clauses, interface references - and a rejected call changes nothing), "diff" (draft vs prod change summary for review; also returns protectedTasks - tasks whose execution state freezes their spec: DONE, NEEDS_HUMAN, SYSTEM_BLOCKED, plus in-flight WORKING, RESULT_READY, plus started tasks (READY between stages with executed stages in their history) - and promotionBlockers, EVERY protected task the draft currently removes or re-signs; clear all promotionBlockers before submitting, because promotion refuses the whole draft while any remain), "discardDraft" (refused while the open draft belongs to a pending PM plan revision lineage - continue that lineage with openRevisionDraft instead). Promotion to prod is PM-only and never happens through this tool. Task spec (upsertTask): {id, taskKind - required, one of "FEATURE_TASK"|"INTEGRATION_TASK"|"MILESTONE_TASK", title - required, parentId (optional parent task id; the task tree hierarchy uses parentId - there is no milestoneId field), dependsOn (optional array of task ids), interfaceIds (optional array of exported interface ids), featureId (FEATURE_TASK: required - the feature-tree contract this task implements; INTEGRATION_TASK: the feature it verifies; MILESTONE_TASK: never set), intent, acceptanceCriteria, testStrategy}. Contract spec (upsertContract): contracts form the FEATURE tree, the reference source of truth: {id, nodeType - required, "feature", parentId (optional parent feature contract id; builds the feature tree), behavior (non-empty array of clause strings, unless integrationScenarios carry acceptanceCriteria), exportedInterfaces, integrationScenarios}. There are no milestone contracts: milestones live only in the task tree. A rejected call returns {error, message, details} listing every validation problem - fix the named fields and resubmit; never resubmit an unchanged payload.',
    Type.Object({
      action: Type.Union([Type.Literal('openDraft'), Type.Literal('openRevisionDraft'), Type.Literal('applyOps'), Type.Literal('diff'), Type.Literal('discardDraft')]),
      ops: Type.Optional(Type.Union([Type.Array(Type.Any(), { minItems: 1, maxItems: 200 }), Type.String()])),
    }, { additionalProperties: false }), async (params) => {
      if (taskContext?.role !== 'tech_lead') throw new Error('TREE_PATCH_REQUIRES_TECH_LEAD');
      const store = openTreeStore();
      try {
        if (params.action === 'openDraft') { const v = store.createDraft({ createdBy: 'tech_lead' }); return { draftVersion: v.version, baseVersion: v.base_version, protectedTasks: store.protectedTasks() }; }
        if (params.action === 'openRevisionDraft') { const v = store.createRevisionDraft({ createdBy: 'tech_lead' }); return { draftVersion: v.version, baseVersion: v.base_version, supersededVersion: v.supersededVersion, protectedTasks: store.protectedTasks() }; }
        if (params.action === 'applyOps') {
          // Models repeatedly encode ops as a JSON string instead of an
          // array (the 2026-11-03 TL repair loop spun on BAD_OP for
          // exactly this). Accept the string form; on failure teach the
          // expected shape instead of returning a bare BAD_OP.
          let ops = params.ops;
          if (typeof ops === 'string') {
            try { ops = JSON.parse(ops); } catch {
              return { error: 'OPS_NOT_ARRAY', message: 'applyOps expects ops to be an ARRAY of operation objects, e.g. [{"op":"upsertTask","task":{"id":"...","taskKind":"FEATURE_TASK","title":"..."}}]. The string you passed is not valid JSON - pass the array itself, not a quoted string.', details: null };
            }
          }
          if (!Array.isArray(ops)) {
            return { error: 'OPS_NOT_ARRAY', message: 'applyOps expects ops to be an ARRAY of operation objects, e.g. [{"op":"upsertTask","task":{"id":"...","taskKind":"FEATURE_TASK","title":"..."}}] or {"op":"removeTask","taskId":"..."}. Pass the array itself, not a JSON string or a single object.', details: null };
          }
          return store.applyTreeOps(ops);
        }
        if (params.action === 'diff') return store.diffDraft();
        if (params.action === 'discardDraft') return { discarded: store.discardDraft() };
        throw new Error(`unknown action ${params.action}`);
      } catch (e) {
        // Store errors carry a code and, for validation failures, the
        // full problem list in e.details. Return them as the result: a
        // thrown error reaches the model as a bare message, which left
        // the tech lead resubmitting blind (found live on iterprobe).
        return { error: e.code ?? 'TREE_PATCH_FAILED', message: e.message, details: e.details ?? null };
      }
    });

  pi.registerTool({
    name: 'ariad_insert_fix_task',
    label: 'Ariad insert triaged fix task',
    description: 'Tech Lead only: place a triaged repair task into the standalone issue queue, parallel to the milestone task tree. The scheduler drains the issue queue before milestone work. The task is not inserted into the task tree: no other task is modified and nothing is replanned. beforeTaskIds is recorded as triage context only and gates nothing.',
    parameters: Type.Object({
      issueId: Type.String({ minLength: 1 }),
      taskId: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      intent: Type.String({ minLength: 1 }),
      acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      beforeTaskIds: Type.Optional(Type.Array(Type.String())),
      milestoneId: Type.Optional(Type.String()),
      ownerMilestoneId: Type.Optional(Type.String()),
      ownerFeatureId: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (taskContext?.role !== 'tech_lead' || typeof insertTriagedFixTask !== 'function') {
        throw new Error('FIX_TASK_REQUIRES_TECH_LEAD');
      }
      const { issueId, taskId, beforeTaskIds = [], ...spec } = params;
      return textResult({ task: insertTriagedFixTask({ issueId, beforeTaskIds, task: {
        id: taskId, ...spec, dependsOn: spec.dependsOn ?? [],
        issueRefs: [issueId],
      } }) });
    },
  });

  pi.registerTool({
    name: 'ariad_report_issue',
    label: 'Ariad report issue',
    description: 'Report a newly discovered product/project defect immediately without ending the current role. Ariad deduplicates it and starts Tech Lead triage/assignment while this role may continue. Report evidence and suspected impact; only Tech Lead triage decides blocking scope.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      description: Type.String({ minLength: 1 }),
      severity: Type.Optional(Type.Union([
        Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('critical'),
      ])),
      affectedComponent: Type.Optional(Type.String()),
      affectedInterface: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.Any())),
      dedupeKey: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (typeof reportIssue !== 'function') {
        throw new Error('ARIAD_REPORT_ISSUE_UNAVAILABLE: this role run is not authorized for issue intake');
      }
      const issue = reportIssue({
        source: {
          kind: 'internal-role',
          ref: taskContext?.taskId && taskContext?.role
            ? taskContext.taskId + ':' + taskContext.role
            : null,
        },
        sourceTaskId: taskContext?.taskId ?? null,
        reportedBy: taskContext?.role ?? null,
        title: params.title,
        description: params.description,
        evidence: params.evidence ?? [],
        severity: params.severity ?? 'medium',
        blocking: false,
        affectedComponent: params.affectedComponent ?? null,
        affectedInterface: params.affectedInterface ?? null,
        fingerprint: params.dedupeKey ?? null,
        context: { reportedDuringRoleExecution: true },
      });
      return textResult({
        accepted: true,
        nonTerminal: true,
        issue,
        guidance: 'The issue is queued for Tech Lead triage. Evaluate the current task independently against its acceptance criteria.',
      });
    },
  });

  pi.registerTool({
    name: 'ariad_memory_write',
    label: 'Ariad project memory write',
    description: 'Save a concise durable project memory and bind it to one or more Ariad artifacts. Do not copy raw chat history; store only reusable project knowledge.',
    parameters: Type.Object({
      text: Type.String({ minLength: 1 }),
      kind: Type.Optional(Type.String()),
      bindings: Type.Optional(Type.Array(Type.Object({
        type: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }))),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const store = new ProjectMemoryStore(workspace);
      try {
        return textResult({ memory: store.remember(params) });
      } finally {
        store.close();
      }
    },
  });
}
