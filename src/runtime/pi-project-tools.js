import { Type } from 'typebox';
import { resolve, relative, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { GodotLspProvider } from './code-intelligence/godot-lsp-provider.js';
import { ProjectMemoryStore } from './project-memory.js';
import { codeSearch, interfaceSearch } from './project-search-tools.js';
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
  'ariad_document_symbols', 'ariad_definition', 'ariad_references', 'ariad_workspace_symbols', 'ariad_call_graph',
  'ariad_memory_search',
  'ariad_memory_write',
  'ariad_session_history',
  'ariad_report_issue',
  'ariad_insert_fix_task',
  'ariad_recover_legacy_issue_task',
  'ariad_plan_features',
  'ariad_plan_milestones',
  'ariad_build_interfaces',
]);

export function registerAriadProjectTools(pi, { workspace, reportIssue = null, insertTriagedFixTask = null, recoverLegacyIssueBlockedTask = null, requestPlanning = null, taskContext = null }) {
  const resolveFile = file => {
    const path = resolve(workspace, file);
    if (relative(workspace, path).startsWith('..') || (isAbsolute(file) && !path.startsWith(workspace + '/'))) throw new Error('FILE_OUTSIDE_WORKSPACE');
    return path;
  };
  let lsp = null;
  const languageServer = () => {
    if (!lsp) lsp = new GodotLspProvider({ projectPath: workspace, port: 7200 + [...workspace].reduce((n, c) => (n + c.charCodeAt(0)) % 1000, 0) });
    return lsp;
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

  for (const [name, phase, downstream] of [
    ['ariad_plan_features', 'feature', ['milestone', 'interface']],
    ['ariad_plan_milestones', 'milestone', ['interface']],
    ['ariad_build_interfaces', 'interface', []],
  ]) {
    addTool(name, `Tech Lead only. Request deterministic ${phase} node planning; downstream dependency validation: ${downstream.join(', ') || 'none'}. This only queues work, never declares completion.`, Type.Object({
      reason: Type.String({ minLength: 1 }),
      scopeNodeId: Type.String({ minLength: 1 }),
      nodes: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), parentId: Type.Union([Type.String(), Type.Null()]) }), { minItems: 1 }),
    }, { additionalProperties: false }), async params => {
      if (taskContext?.role !== 'tech_lead') throw new Error('PLANNING_REQUIRES_TECH_LEAD');
      if (typeof requestPlanning !== 'function') throw new Error('PLANNING_SCHEDULER_NOT_CONNECTED');
      return requestPlanning({ phase, downstream, ...params, requestedByTaskId: taskContext.taskId });
    });
  }

  pi.registerTool({
    name: 'ariad_recover_legacy_issue_task',
    label: 'Ariad recover legacy issue-blocked task',
    description: 'Tech Lead only, explicit operator-requested one-time repair. Restore an idle delivery task to READY only if WAITING_REPLAN was caused by legacy DISCOVERED_BLOCKING_ISSUE and no subsequent Debugger/Replan evidence exists. Preserve Issue and audit trail.',
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (taskContext?.role !== 'tech_lead' || typeof recoverLegacyIssueBlockedTask !== 'function') {
        throw new Error('TASK_RECOVERY_REQUIRES_TECH_LEAD');
      }
      return textResult({ task: recoverLegacyIssueBlockedTask(params) });
    },
  });

  pi.registerTool({
    name: 'ariad_insert_fix_task',
    label: 'Ariad insert triaged fix task',
    description: 'Tech Lead only: insert a new independent repair task into the active delivery DAG, adding prerequisite edges only to idle READY tasks. Does not pause active work or replan.',
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
