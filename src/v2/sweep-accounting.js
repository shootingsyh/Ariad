// Sweep accounting gate (owner-approved product fix, 2026-11-15).
//
// Since b9da159 the Tech Lead prompt mandates an EXISTING TASK SWEEP with
// a SWEEP ACCOUNTING in the Tech Lead result whenever a planning batch
// carries new or changed requirements, and the PM prompt checks for it
// under PLAN FIDELITY. That mandate was prompt-only: nothing verified the
// accounting mechanically, so Tech Lead results kept reaching PM review
// with the accounting missing, partial, or silently dropped by a later
// repair result - and every miss cost a full planning round (SRPG battle
// iteration: PM_PLAN_REVISION rounds 48-52 all failed on this one point
// before the PM escalated to a human).
//
// This module is the deterministic half of the rule, enforced by the
// plan validator (see default-roles): in a requirements-changing batch,
// the LAST completed Tech Lead authorship result (decompose, then
// repair-1..3) must carry a sweep accounting that covers EVERY task of
// the draft's base version. Presence and ID coverage are mechanical;
// whether each disposition is right remains the PM's judgement.

export const SWEEP_REQUIREMENT_PURPOSES = [
  'PM_PLAN_REVISION',
  'LOCAL_REPLAN',
  'INITIAL_PLAN',
  'UPDATE_DELIVERY_PLAN',
];

export const SWEEP_AUTHORSHIP_PURPOSES = ['PLANNER_DECOMPOSE', 'PLANNER_REPAIR'];

export function batchRequiresSweepAccounting(requests) {
  return (requests ?? []).some(item => SWEEP_REQUIREMENT_PURPOSES.includes(item?.request?.purpose));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Collect the raw accounting entries from a Tech Lead result payload.
// Accepted shapes (all have been emitted by Tech Lead sessions):
//   result.sweepAccounting / result.completeSweepAccounting as
//   - an array of strings ("T-battle - ... - REVISED: ...")
//   - an array of objects ({ taskId } / { id })
//   - an object keyed by disposition, values arrays of the above
// Returns null when the payload carries no accounting at all.
export function sweepAccountingEntries(result) {
  const payload = result && typeof result === 'object' ? result : null;
  if (!payload) return null;
  const raw = payload.sweepAccounting ?? payload.completeSweepAccounting
    ?? payload.result?.sweepAccounting ?? payload.result?.completeSweepAccounting;
  if (raw == null) return null;
  const entries = [];
  const push = (value) => {
    if (typeof value === 'string') entries.push({ taskId: null, text: value });
    else if (value && typeof value === 'object') {
      const taskId = value.taskId ?? value.id ?? null;
      entries.push({ taskId, text: taskId ?? '' });
    }
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (typeof raw === 'string') entries.push({ taskId: null, text: raw });
  else if (typeof raw === 'object') {
    Object.values(raw).forEach(list => { if (Array.isArray(list)) list.forEach(push); });
  }
  return entries;
}

// Which of the base task IDs does the accounting cover? Object entries
// cover by exact taskId; string entries cover an ID they mention as a
// whole token (IDs are hyphenated, so a mention must not be flanked by
// [A-Za-z0-9-] on either side - "T-battle" inside "T-battle-hud" does
// not count).
export function sweepAccountingCoverage(baseTaskIds, entries) {
  const covered = new Set();
  const texts = [];
  for (const entry of entries ?? []) {
    if (entry.taskId) covered.add(entry.taskId);
    if (entry.text) texts.push(entry.text);
  }
  for (const id of baseTaskIds ?? []) {
    if (covered.has(id)) continue;
    const mention = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(id)}(?![A-Za-z0-9-])`);
    if (texts.some(text => mention.test(text))) covered.add(id);
  }
  return covered;
}

// authorshipResults: [{ taskId, result }] for the batch's completed Tech
// Lead authorship tasks, in flow order (decompose first, repair-3 last).
// Only the LAST one is judged: it must carry the complete accounting for
// the draft as it stands when it completed - an accounting left behind
// by an earlier decompose does not cover a tree a later repair changed.
export function evaluateSweepAccounting({ baseTaskIds, authorshipResults }) {
  const base = [...(baseTaskIds ?? [])];
  if (base.length === 0) return { ok: true, missing: [], sourceTaskId: null };
  const completed = (authorshipResults ?? []).filter(item => item?.result != null);
  if (completed.length === 0) {
    return {
      ok: false, code: 'SWEEP_ACCOUNTING_ABSENT', sourceTaskId: null, missing: base,
      error: 'no completed Tech Lead authorship result in this batch is available to carry the sweep accounting',
    };
  }
  const last = completed[completed.length - 1];
  const entries = sweepAccountingEntries(last.result);
  if (!entries || entries.length === 0) {
    return {
      ok: false, code: 'SWEEP_ACCOUNTING_ABSENT', sourceTaskId: last.taskId, missing: base,
      error: `the latest Tech Lead result (${last.taskId}) carries no sweepAccounting - the batch's final Tech Lead result must carry the complete SWEEP ACCOUNTING for the draft as it now stands`,
    };
  }
  const covered = sweepAccountingCoverage(base, entries);
  const missing = base.filter(id => !covered.has(id));
  if (missing.length > 0) {
    return {
      ok: false, code: 'SWEEP_ACCOUNTING_INCOMPLETE', sourceTaskId: last.taskId, missing,
      error: `the sweep accounting in ${last.taskId} does not cover every pre-existing task - missing: ${missing.join(', ')}`,
    };
  }
  return { ok: true, missing: [], sourceTaskId: last.taskId };
}

// The batch's Tech Lead authorship results in flow order, read from the
// v2 store: decompose (round 0) then repair rounds 1..3. Only tasks with
// a recorded ROLE_RESULT count; the latest such result per task wins.
export function authorshipResultsForBatch(store, task) {
  const batchId = task?.input?.planningBatchId;
  if (!batchId || typeof store?.listTasks !== 'function') return [];
  const orderOf = (t) => {
    if (t.input?.purpose === 'PLANNER_DECOMPOSE') return 0;
    const round = Number(t.input?.round);
    return Number.isFinite(round) && round > 0 ? round : 99;
  };
  return (store.listTasks(task.projectId) ?? [])
    .filter(t => t?.input?.planningBatchId === batchId && SWEEP_AUTHORSHIP_PURPOSES.includes(t?.input?.purpose))
    .map(t => {
      const entry = [...(t.history ?? [])].reverse().find(h => h?.type === 'ROLE_RESULT');
      return entry ? { taskId: t.id, order: orderOf(t), result: entry.result ?? null } : null;
    })
    .filter(item => item && item.result != null)
    .sort((a, b) => a.order - b.order)
    .map(({ taskId, result }) => ({ taskId, result }));
}
