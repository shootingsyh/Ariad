/** Planning-flow helpers extracted from default-roles.js: artifact
 * plan resolution, frontier/iteration plumbing, failure counters.
 * Pure functions over (store, task) - no factory state. */
import { ensureTakeoverReviewState } from './takeover-gate.js';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// Escalation whitelist (product rule): a human may be summoned only when
// the system is dead after exhausting recovery, or when the PM judges the
// requirements themselves are the problem. The PM's NEEDS_HUMAN is honored
// only when it carries concrete requirements questions; without them it
// falls through to the body's revision/retry path like any other
// non-accepting outcome.
export function pmEscalationHasQuestions(result) {
  const questions = result?.result?.questions;
  return Array.isArray(questions) && questions.some(q => typeof q === 'string' && q.trim().length > 0);
}

export function latestRoleResult(task) {
  const history = task?.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.type === 'ROLE_RESULT') return history[i];
  }
  return null;
}

export function flowTasks(store, task) {
  return store.listTasks(task.projectId, { flowId: task.flowId });
}

export function predecessorResults(store, task) {
  const byId = new Map(flowTasks(store, task).map(item => [item.id, item]));
  return (task.dependsOn ?? []).map(id => latestRoleResult(byId.get(id))).filter(Boolean);
}

export function recordArtifactIncidentOnce(store, task, artifactRef, failure) {
  const exists = store.listIncidents(task.projectId).some(
    incident => incident?.type === 'PLANNER_ARTIFACT_INVALID'
      && incident?.artifactRef === artifactRef
      && incident?.failure === failure
  );
  if (exists) return;
  store.recordIncident({
    projectId: task.projectId,
    taskId: task.id,
    type: 'PLANNER_ARTIFACT_INVALID',
    artifactRef,
    failure,
  });
}

export function failureCount(task) {
  const history = task.history ?? [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type !== 'ROLE_RESULT') continue;
    if (entry.role === 'project_debugger' && entry.outcome === 'WRONG_IMPLEMENTATION_APPROACH') break;
    if ((entry.role === 'tester' || entry.role === 'reviewer') && entry.outcome === 'NOT_PASS') count += 1;
  }
  return count;
}

export function roleSealFailureCount(task, role) {
  const history = task.history ?? [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (
      (entry?.type === 'ROLE_RESULT' && entry.role === 'project_debugger')
      || entry?.type === 'DEBUGGER_ROUTE'
    ) break;
    if (entry?.type === 'ROLE_SEAL_FAILED' && entry.ownerRole === role) count += 1;
    if (role === 'developer' && entry?.type === 'INTERFACE_SEAL_FAILED') count += 1;
  }
  return count;
}

export function strategyEpoch(task) {
  return 1 + (task.history ?? []).filter(
    entry => entry?.type === 'ROLE_RESULT'
      && entry.role === 'project_debugger'
      && entry.outcome === 'WRONG_IMPLEMENTATION_APPROACH'
  ).length;
}

export function planningSkipIds(task, round) {
  const batchId = task.input?.planningBatchId;
  if (!batchId) return [];
  const id = name => `planner:${batchId}:${name}`;
  if (round === 1) return [
    id('repair-1'),
    id('validate-2'), id('critic-2'), id('repair-2'),
    id('validate-3'), id('critic-3'), id('repair-3'),
  ];
  if (round === 2) return [
    id('repair-2'),
    id('validate-3'), id('critic-3'), id('repair-3'),
  ];
  if (round === 3) return [id('repair-3')];
  return [];
}

export function planningBatchRequests(store, task) {
  const batchId = task.input?.planningBatchId;
  if (!batchId) return [];
  return store.listPlanningRequests(task.projectId).filter(item => item.batchId === batchId);
}

export function isTakeoverPlanningTask(store, task) {
  const project = ensureTakeoverReviewState(store, task.projectId);
  return project.mode === 'TAKEOVER' && project.takeoverReviewRequired === true;
}


export function iterationRequest(store, task) {
  return planningBatchRequests(store, task).find(item => item.request?.purpose === 'UPDATE_DELIVERY_PLAN') ?? null;
}

