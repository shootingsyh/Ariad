// Read-only state-aware migration preflight. Never mutates the live project.
import { buildUnifiedTaskTree, validateUnifiedTaskTree } from './unified-task-tree.js';

export function preflightUnifiedTaskMigration({ artifactRoot, liveTasks }) {
  const preview = buildUnifiedTaskTree(artifactRoot);
  const validation = validateUnifiedTaskTree(preview);
  const delivery = liveTasks.filter(t => t.scope === 'delivery');
  const liveById = new Map(delivery.map(t => [t.id,t]));
  const oldToNew = new Map(preview.tasks.filter(t => t.legacyIntegrationTaskId)
    .map(t => [t.legacyIntegrationTaskId,t.id]));
  const target = new Set(preview.tasks.map(t=>t.id));
  const extra = delivery.filter(t=>!target.has(t.id)&&!oldToNew.has(t.id));
  const missing = preview.tasks.filter(t=>!liveById.has(t.id)&&!liveById.has(t.legacyIntegrationTaskId));
  const active = liveTasks.filter(t=>['WORKING','RESULT_READY'].includes(t.state));
  const migrations = preview.tasks.map(task => {
    const sourceId = task.legacyIntegrationTaskId ?? task.id;
    const source = liveById.get(sourceId);
    return { id: task.id, sourceId, state: source?.state ?? 'MISSING', historyEntries: source?.history?.length ?? 0,
      version: source?.version ?? null, executionMode: task.executionMode,
      dependsOn: task.dependsOn, interfaceIds: task.interfaceIds ?? [] };
  });
  const blockers = [
    ...(!validation.ok ? ['UNIFIED_GRAPH_INVALID'] : []),
    ...(active.length ? ['ACTIVE_TASKS'] : []),
    ...(extra.length ? ['UNMAPPED_LIVE_TASKS'] : []),
    ...(missing.length ? ['MISSING_TASKS'] : []),
    'SCHEDULER_AGGREGATE_GATE_NOT_WIRED',
    'LIVE_INTERFACE_BINDINGS_NOT_MIGRATED',
  ];
  return { safeToApply: blockers.length === 0, blockers, stats: preview.stats,
    live: { total: delivery.length, states: Object.fromEntries([...new Set(delivery.map(t=>t.state))].map(s=>[s,delivery.filter(t=>t.state===s).length])),
      preservedHistoryEntries: migrations.reduce((n,t)=>n+t.historyEntries,0) },
    idMap: Object.fromEntries(oldToNew),
    extra: extra.map(t=>({id:t.id,state:t.state,historyEntries:t.history?.length??0})),
    missing: missing.map(t=>t.id), migrations, validation };
}
