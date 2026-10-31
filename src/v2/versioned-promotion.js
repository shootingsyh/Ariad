import { buildExecutionGraph } from './execution-graph.js';
import { gateSignature, stableStringify } from './versioned-store.js';

// PM promotion for DB-first projects: materialize the open draft version
// into the runtime store's delivery tasks (same guard semantics as
// reconcileUnifiedTaskTree: gate-signature drift on DONE/blocked tasks is
// refused, in-flight changes defer, prose drift on DONE/blocked is
// tolerated and never rewritten), then flip the prod pointer in the
// versioned store. Materialization is idempotent: if the flip step fails,
// a retry re-runs with no further writes and flips again.
const specSignature = task => stableStringify({
  gate: gateSignature(task),
  title: task.title ?? null,
  intent: task.intent ?? null,
  acceptanceCriteria: task.acceptanceCriteria ?? task.input?.acceptanceCriteria ?? [],
  testStrategy: task.testStrategy ?? null,
});

export function reconcileVersionedDraft({ versionedStore, store, projectId, approvedBy = null }) {
  const project = store.getProject(projectId);
  if (!project) throw new Error('VERSIONED_UNKNOWN_PROJECT');
  const draft = versionedStore.getOpenDraft();
  if (!draft) {
    const err = new Error('NO_OPEN_DRAFT');
    err.code = 'NO_OPEN_DRAFT';
    throw err;
  }
  const validationErrors = versionedStore.validateVersion(draft.version);
  if (validationErrors.length) {
    const err = new Error(`TREE_VALIDATION_FAILED: ${validationErrors.join('; ')}`);
    err.code = 'TREE_VALIDATION_FAILED';
    err.details = validationErrors;
    throw err;
  }
  const existing = store.listTasks(projectId, { scope: 'delivery' });
  const compiled = versionedStore.listSpecTasks(draft.version)
    .map(spec => ({ ...spec, unifiedTaskSchemaVersion: 1 }));
  const wanted = new Map(compiled.map(t => [t.id, t]));
  const current = new Map(existing.map(t => [t.id, t]));
  const issues = [];
  const inFlightChanged = [];
  const creates = [], updates = [], obsoletes = [];
  for (const spec of compiled) {
    const task = current.get(spec.id);
    if (!task) { creates.push(spec); continue; }
    if (specSignature(task) === specSignature(spec)) continue;
    if (gateSignature(task) !== gateSignature(spec)) {
      if (task.state === 'DONE') issues.push({ id: task.id, reason: 'REVISE_COMPLETED_TASK' });
      else if (task.state === 'WORKING' || task.state === 'RESULT_READY' || task.execution) inFlightChanged.push(task.id);
      else if (task.state === 'NEEDS_HUMAN' || task.state === 'SYSTEM_BLOCKED') issues.push({ id: task.id, reason: 'REVISE_BLOCKED_TASK' });
      else updates.push(spec);
    } else if (['READY', 'WAITING_REPLAN'].includes(task.state)) {
      updates.push(spec);
    }
  }
  for (const task of existing) {
    if (wanted.has(task.id) || task.state === 'OBSOLETE' || task.state === 'SKIPPED') continue;
    if (task.state === 'DONE') issues.push({ id: task.id, reason: 'REMOVE_COMPLETED_TASK' });
    else if (task.state === 'READY' || task.state === 'WAITING_REPLAN') obsoletes.push(task);
    else if (task.state === 'WORKING' || task.state === 'RESULT_READY' || task.execution) inFlightChanged.push(task.id);
    else issues.push({ id: task.id, reason: 'REMOVE_UNFINISHED_TASK' });
  }
  if (inFlightChanged.length) {
    const error = new Error(`UNIFIED_TASK_DELIVERY_IN_FLIGHT: ${[...new Set(inFlightChanged)].join(',')}`);
    error.code = 'UNIFIED_TASK_DELIVERY_IN_FLIGHT';
    throw error;
  }
  if (issues.length) {
    const error = new Error(`UNIFIED_TASK_TREE_RECONCILE_REQUIRES_REVIEW: ${JSON.stringify(issues)}`);
    error.issues = issues;
    throw error;
  }
  const updatedIds = new Set(updates.map(t => t.id));
  const obsoleteIds = new Set(obsoletes.map(t => t.id));
  const resulting = [
    ...existing.filter(t => !obsoleteIds.has(t.id)).map(t => (updatedIds.has(t.id) ? { ...t, ...wanted.get(t.id) } : t)),
    ...creates,
  ];
  buildExecutionGraph(resulting);
  const now = new Date().toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (store.getProject(projectId).version !== project.version) throw new Error('UNIFIED_TASK_PROJECT_VERSION_CONFLICT');
    for (const task of obsoletes) {
      store.updateTask(task.id, task.version, {
        state: 'OBSOLETE', execution: null,
        history: [...(task.history ?? []), { type: 'TASK_TREE_OBSOLETE', at: now }],
      });
    }
    for (const spec of creates) {
      store.createTask({ ...spec, projectId, state: 'READY', stage: spec.stage ?? 'developer' });
    }
    for (const spec of updates) {
      const task = current.get(spec.id);
      store.updateTask(task.id, task.version, {
        parentId: spec.parentId, executionMode: spec.executionMode,
        title: spec.title, intent: spec.intent,
        acceptanceCriteria: spec.acceptanceCriteria, testStrategy: spec.testStrategy,
        dependsOn: spec.dependsOn, interfaceIds: spec.interfaceIds, logicalRefs: spec.logicalRefs,
        input: { ...(task.input ?? {}), ...(spec.input ?? {}) },
        history: [...(task.history ?? []), { type: 'UNIFIED_TASK_TREE_RECONCILED', at: now, previousState: task.state }],
      });
    }
    store.db.exec('COMMIT');
  } catch (err) { store.db.exec('ROLLBACK'); throw err; }
  const flip = versionedStore.promoteDraft({ approvedBy });
  return {
    created: creates.map(t => t.id),
    updated: updates.map(t => t.id),
    obsoleted: obsoletes.map(t => t.id),
    total: compiled.length,
    version: flip.version,
    contentHash: flip.contentHash,
  };
}
