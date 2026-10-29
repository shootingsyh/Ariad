/** Planning-flow helpers extracted from default-roles.js: artifact
 * plan resolution, frontier/iteration plumbing, failure counters.
 * Pure functions over (store, task) - no factory state. */
import { applyFeatureTreeDiff, loadFeatureTreeDiff, loadPlannerArtifactPlan, materializeLogicalTree, validatePlannerArtifactPlan } from './planner-artifacts.js';
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

export function resolveArtifactResult(store, task, result, artifactRoot) {
  if (!result?.artifactRef || !artifactRoot) return result;
  const root = resolve(artifactRoot);
  const file = resolve(root, result.artifactRef);
  if (file !== root && !file.startsWith(root + sep)) {
    const failure = 'artifactRef escapes Ariad artifact root';
    recordArtifactIncidentOnce(store, task, result.artifactRef, failure);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const failure = error?.message ?? String(error);
    recordArtifactIncidentOnce(store, task, result.artifactRef, failure);
    return null;
  }
}

export function currentArtifactPlan(artifactRoot) {
  const raw = loadPlannerArtifactPlan(artifactRoot);
  if (!raw) return null;
  return validatePlannerArtifactPlan(raw).plan;
}

export function latestLegacyPlanInFlow(store, task, artifactRoot) {
  const tasks = flowTasks(store, task);
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const raw = latestRoleResult(tasks[i])?.result;
    const result = resolveArtifactResult(store, task, raw, artifactRoot);
    const candidate = result?.plan ?? result;
    // Version 3 in task history is a compiled/validated view, not a raw
    // filesystem artifact plan. Never feed it back into the artifact validator.
    if (candidate?.version === 2 && Array.isArray(candidate?.tasks)) return candidate;
  }
  return null;
}

export function latestPlanInFlow(store, task, artifactRoot) {
  try {
    const artifactPlan = currentArtifactPlan(artifactRoot);
    if (artifactPlan) return artifactPlan;
  } catch {
    // During decompose/repair the filesystem may be temporarily incomplete.
    // Validation tasks handle the authoritative error; prompts may fall back
    // to the last valid legacy v2 candidate while writing is in progress.
  }
  return latestLegacyPlanInFlow(store, task, artifactRoot);
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


export function latestFrontierCompletion(store, task) {
  const tasks = flowTasks(store, task);
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const history = tasks[i]?.history ?? [];
    for (let j = history.length - 1; j >= 0; j -= 1) {
      if (history[j]?.type === 'PLANNER_FRONTIER_LAYER_COMPLETE') return history[j];
    }
  }
  return null;
}

export function iterationRequest(store, task) {
  return planningBatchRequests(store, task).find(item => item.request?.purpose === 'UPDATE_DELIVERY_PLAN') ?? null;
}

export function materializeIterationFeatureTree(store, task, artifactRoot) {
  const request = iterationRequest(store, task);
  if (!request) return null;
  const diff = loadFeatureTreeDiff(artifactRoot);
  if (!diff) {
    const error = new Error('ITERATION_FEATURE_TREE_DIFF_REQUIRED: iteration planning requires feature-tree-diff.json');
    error.code = 'ITERATION_FEATURE_TREE_DIFF_REQUIRED';
    throw error;
  }
  const targetVersion = request.context?.targetVersion ?? request.request?.iteration;
  if (diff.targetVersion !== targetVersion) {
    const error = new Error(`ITERATION_FEATURE_TREE_DIFF_REQUIRED: diff targets version ${diff.targetVersion}, expected ${targetVersion}`);
    error.code = 'ITERATION_FEATURE_TREE_DIFF_REQUIRED';
    throw error;
  }
  const project = store.getProject(task.projectId);
  const nextNodes = applyFeatureTreeDiff(project?.logicalNodes ?? [], diff);
  materializeLogicalTree(artifactRoot, nextNodes);
  return { diff, nextNodes };
}


