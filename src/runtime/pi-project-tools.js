import { Type } from 'typebox';
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
  'ariad_memory_search',
  'ariad_memory_write',
  'ariad_session_history',
  'ariad_report_issue',
  'ariad_insert_fix_task',
  'ariad_recover_legacy_issue_task',
]);

export function registerAriadProjectTools(pi, { workspace, reportIssue = null, insertTriagedFixTask = null, recoverLegacyIssueBlockedTask = null, taskContext = null }) {
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
