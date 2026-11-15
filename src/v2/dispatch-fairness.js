// Dispatch fairness: a runnable delivery task must not starve silently.
//
// SRPG 2026-11-14: T-fix-battlefield-camera-map-rendering sat READY for
// hours behind an in-flight dependency while the old construction kept
// cycling through ux rejections, and T-navigation /
// T-fix-battlefield-location-routing (no dependencies at all) were READY
// since spec v1/v7 without ever being dispatched. Impact-ordered dispatch
// has no aging, and project status shows every spec task as READY whether
// or not it ever started — so nothing distinguished "waiting its turn"
// from "starved". This module is the single place that answers, for one
// task, "could it start now, since when, and is it starved", so the
// scheduler can age starved work to the front and project status can
// name it.

export const STARVED_AFTER_MS = 60 * 60 * 1000;

function ms(value) {
  if (value == null) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// Earliest moment this task could have started, or null when it cannot
// start yet. A task with no prerequisites could have started when it first
// entered the prod spec; a task with prerequisites, when its last
// prerequisite reached DONE/SKIPPED. blockedBy names the prerequisites
// still holding it back.
export function runnableSince(task, byId, firstSeenAtMs) {
  if (!task || task.state !== 'READY') return { runnableSinceMs: null, blockedBy: [] };
  const blockedBy = [];
  let since = ms(firstSeenAtMs);
  for (const depId of task.dependsOn ?? []) {
    const dep = byId.get(depId);
    if (!dep || !['DONE', 'SKIPPED'].includes(dep.state)) {
      blockedBy.push(depId);
      continue;
    }
    const doneAt = ms(dep.updatedAt);
    if (doneAt != null) since = since == null ? doneAt : Math.max(since, doneAt);
  }
  if (blockedBy.length) return { runnableSinceMs: null, blockedBy };
  return { runnableSinceMs: since, blockedBy: [] };
}

export function auditTasks(tasks, { nowMs = Date.now(), firstSeenAt = new Map(), thresholdMs = STARVED_AFTER_MS } = {}) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const out = [];
  for (const task of tasks) {
    if (['DONE', 'SKIPPED', 'OBSOLETE'].includes(task.state)) continue;
    const { runnableSinceMs, blockedBy } = runnableSince(task, byId, firstSeenAt.get(task.id) ?? ms(task.createdAt));
    const started = (task.history ?? []).some(entry => entry?.type === 'ROLE_RESULT');
    const entry = {
      id: task.id,
      state: task.state,
      runnable: runnableSinceMs != null,
      runnableSinceMs,
      blockedBy,
      started,
      waitMs: runnableSinceMs == null ? null : Math.max(0, nowMs - runnableSinceMs),
      starved: false,
    };
    entry.starved = entry.runnable && !entry.started && entry.waitMs != null && entry.waitMs >= thresholdMs;
    out.push(entry);
  }
  return out;
}

// Starved runnable work goes first (oldest first); everything else keeps
// its existing order (impact, then id) so normal scheduling is unchanged.
// Array sort is stable, so returning 0 for two non-starved candidates
// preserves the caller's order exactly.
export function orderCandidates(candidates, auditById) {
  const starvedRank = candidate => (auditById.get(candidate.task.id)?.starved ? 0 : 1);
  const starvedSince = candidate => auditById.get(candidate.task.id)?.runnableSinceMs ?? Number.POSITIVE_INFINITY;
  return [...candidates].sort((a, b) => starvedRank(a) - starvedRank(b) || starvedSince(a) - starvedSince(b));
}
