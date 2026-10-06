/**
 * Recover a stale PM gate created while rebuilding the planning model.
 *
 * This is NOT approval: it discards only the premature *delivery approval*
 * question, appends an audit entry, and queues a fresh deterministic migration
 * validation pass. Genuine unresolved product decisions are left untouched.
 */
export function recoverPrematureMigrationApprovalGate(store, projectId) {
  if (store.getProject(projectId)?.planningModelMigration?.status !== 'REBUILDING') return [];
  const recovered = [];
  for (const task of store.listTasks(projectId)) {
    if (task.state !== 'NEEDS_HUMAN' || task.scope !== 'control'
      || task.stage !== 'pm' || task.input?.purpose !== 'PLANNER_PM_REVIEW'
      || task.input?.versionMigration !== true) continue;
    const result = [...(task.history ?? [])].reverse().find(item => item?.type === 'ROLE_RESULT');
    if (result?.role !== 'pm' || result?.outcome !== 'NEEDS_HUMAN'
      || result?.result?.startDelivery !== false) continue;
    const gateText = [
      result.summary, result.result?.reason, result.result?.guidance,
      ...(result.result?.questions ?? []),
    ].filter(Boolean).join(' ');
    if (!/V2\.GATE|authoriz(?:e|ation).*delivery|approve.*delivery|delivery.*approv/i.test(gateText)) continue;

    const requestId = `${projectId}:migration-revalidate:${task.input.planningBatchId}`;
    store.appendTaskHistory(task.id, task.version, {
      type: 'PREMATURE_MIGRATION_DELIVERY_GATE_REJECTED',
      role: 'migration_recovery',
      reason: 'Migration must pass validator before human delivery approval; no delivery authorization was granted.',
      nextValidationRequestId: requestId,
      at: new Date().toISOString(),
    }, { state: 'DONE', execution: null });
    if (!store.getPlanningRequest(requestId)) {
      store.enqueuePlanningRequest({
        id: requestId, projectId,
        request: {
          purpose: 'VERSION_MIGRATION_FINALIZE',
          guidance: 'Revalidate migration artifacts, repair any errors, and finalize with Delivery disabled. Do not request delivery authorization during migration.',
        },
        context: { sourceKind: 'migration-gate-recovery', invalidatedTaskId: task.id },
      });
    }
    recovered.push({ taskId: task.id, requestId });
  }
  return recovered;
}
