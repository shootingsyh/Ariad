// Resolution for debugger-requested task replans (owner rule, 2026-11-05).
//
// When a project_debugger diagnosis returns TASK_TOO_LARGE, the target
// task parks in WAITING_REPLAN and a REPLAN_TASK planning request goes to
// the Tech Lead, who splits the task along the diagnosis's ownership
// lines. When the planning batch that claimed the request completes
// (store.completePlanningBatch), the parked task must resolve in the same
// settle step, or it would wait forever - nothing else emits the
// WAITING_REPLAN exits the state machine defines:
// - spec gone (the split replaced the task): the exec record is marked
//   OBSOLETE; its remaining work lives in the successor tasks the split
//   created, which the scheduler already sees as fresh READY tasks.
// - spec present (TL shrunk the task to its retained scope, or judged
//   the split unnecessary): the task returns to READY and is scheduled
//   with its revised spec.
// Idempotent: only tasks still parked in WAITING_REPLAN are touched, so
// repeat settles and unrelated batches are no-ops.

export function resolveReplannedTasks(store, projectId, requests) {
  const resolved = [];
  for (const item of requests ?? []) {
    if (item?.request?.purpose !== 'REPLAN_TASK') continue;
    const taskId = item.request.taskId;
    if (!taskId) continue;
    const task = store.getTask(taskId);
    if (!task || task.projectId !== projectId) continue;
    const at = new Date().toISOString();
    if (task.specMissing) {
      // The split removed the spec: the merged view already reports the
      // task OBSOLETE, so the park is invisible in its state. The park's
      // own DEBUGGER_ROUTE history entry is the evidence that this orphan
      // is the task the settled request parked (and not an unrelated
      // removal); without it, leave the record alone.
      const history = task.history ?? [];
      const routeAt = history.findLastIndex(h => h?.type === 'DEBUGGER_ROUTE' && h?.route === 'tech_lead');
      const resolvedAt = history.findLastIndex(h => h?.type === 'REPLAN_RESOLVED');
      if (routeAt < 0 || resolvedAt > routeAt) continue;
      store.appendTaskHistory(task.id, task.version, {
        type: 'REPLAN_RESOLVED', disposition: 'SPLIT_REPLACED',
        planningBatchId: item.batchId ?? null, at,
      }, { state: 'OBSOLETE', execution: null });
      resolved.push({ taskId, disposition: 'SPLIT_REPLACED' });
    } else {
      if (task.state !== 'WAITING_REPLAN') continue;
      store.appendTaskHistory(task.id, task.version, {
        type: 'REPLAN_RESOLVED', disposition: 'RESUMED',
        planningBatchId: item.batchId ?? null, at,
      }, { state: 'READY', execution: null });
      resolved.push({ taskId, disposition: 'RESUMED' });
    }
  }
  return resolved;
}
