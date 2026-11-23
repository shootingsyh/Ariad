// Sweep accounting (owner design, 2026-11-22): the accounting is
// DERIVED from the draft's diff against its base version - never
// authored by the Tech Lead, and no longer gated on a hand-written
// list. (History: from b9da159 to 2026-11-22 the Tech Lead had to
// author a complete sweep accounting in its result, and the plan
// validator rejected batches whose final Tech Lead result lacked
// one - SWEEP_ACCOUNTING_INCOMPLETE. SRPG batch-234 showed the
// failure mode: the accounting described the draft the Tech Lead
// MEANT to write, a repair round rebuilt the draft without the
// change, and the batch promoted an unchanged tree. The derived
// accounting below is computed from the diff itself, so it cannot
// disagree with what would actually land.)

export const SWEEP_AUTHORSHIP_PURPOSES = ['PLANNER_DECOMPOSE', 'PLANNER_REPAIR'];


// The batch's Tech Lead authorship results in flow order, read from the
// v2 store: decompose (round 0) then repair rounds 1..3. Only tasks with
// a recorded ROLE_RESULT count; the latest such result per task wins.
export function authorshipResultsForBatch(store, task) {
  const batchId = task?.input?.planningBatchId;
  if (!batchId || typeof store?.listAllTasks !== 'function') return [];
  const orderOf = (t) => {
    if (t.input?.purpose === 'PLANNER_DECOMPOSE') return 0;
    const round = Number(t.input?.round);
    return Number.isFinite(round) && round > 0 ? round : 99;
  };
  const authored = (store.listAllTasks(task.projectId) ?? [])
    .filter(t => t?.input?.planningBatchId === batchId && SWEEP_AUTHORSHIP_PURPOSES.includes(t?.input?.purpose))
    .map(t => {
      const entry = [...(t.history ?? [])].reverse().find(h => h?.type === 'ROLE_RESULT');
      return entry ? { taskId: t.id, order: orderOf(t), result: entry.result ?? null } : null;
    })
    .filter(item => item && item.result != null)
    .sort((a, b) => a.order - b.order)
    .map(({ taskId, result }) => ({ taskId, result }));
  // Gate-repair submissions (2026-11-15 fix): when the final-validate
  // gate fails, the Tech Lead repairs ON the validate task itself and
  // its result is recorded in that task's own history
  // (GATE_REPAIR_RETURNED). The validate task is not an authorship task,
  // so the scan above never sees those submissions: a gate repair could
  // not satisfy this gate, the re-check failed identically, and the
  // batch escalated to SYSTEM_BLOCKED (SRPG batch-55). Count the
  // validate task's latest Tech Lead result as the batch's latest
  // authorship result.
  if (task?.input?.purpose === 'PLANNER_VALIDATE' || task?.input?.purpose === 'PLANNER_FINAL_VALIDATE') {
    const own = [...(task.history ?? [])].reverse()
      .find(h => h?.type === 'ROLE_RESULT' && h?.role === 'tech_lead' && h.result != null);
    if (own) authored.push({ taskId: task.id, result: own.result });
  }
  return authored;
}

// Derived sweep accounting (owner design, 2026-11-22): the accounting is
// COMPUTED from the draft's actual diff against its base version, never
// authored by the Tech Lead. Every pre-existing task is accounted for by
// construction: removed -> retired, field-changed -> revised (reason
// names the changed fields), untouched -> non-conflicting; tasks the
// draft adds are listed as created. Reviewers judge these dispositions
// against the batch's purpose; there is no hand-written list to lose.
export function derivedSweepAccounting(diff, baseTaskIds) {
  const entries = [];
  const changed = diff?.detail?.tasks ?? {};
  const removed = new Set(diff?.tasks?.removed ?? []);
  for (const id of baseTaskIds ?? []) {
    if (removed.has(id)) {
      entries.push({ taskId: id, disposition: 'retired', reason: 'removed by the draft' });
    } else if (changed[id]) {
      entries.push({ taskId: id, disposition: 'revised', reason: `fields changed: ${Object.keys(changed[id]).join(', ')}` });
    } else {
      entries.push({ taskId: id, disposition: 'non-conflicting', reason: 'unchanged by the draft' });
    }
  }
  for (const id of diff?.tasks?.added ?? []) {
    entries.push({ taskId: id, disposition: 'created', reason: 'new in the draft' });
  }
  return entries;
}
