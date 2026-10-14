import { TASK_KINDS, effectiveTaskKind } from './control-task-policy.js';

// Compatibility adapter: the four executor families share one task envelope.
// No SQLite migration: existing taskKind, stage, input, workflowState and execution
// remain the durable fields until each executor is migrated.
export const EXECUTOR_FAMILIES = Object.freeze({
  MILESTONE: 'milestone',
  PLANNING: 'planning',
  SUB_PLAN: 'sub-plan',
  ADHOC: 'adhoc',
});

export const QUEUES = Object.freeze({
  MILESTONE: 'milestone',
  PLANNING: 'planning',
  SUB_PLAN: 'sub-plan',
  ADHOC: 'adhoc',
});

export function executorFamily(task) {
  const kind = effectiveTaskKind(task);
  switch (kind) {
    case TASK_KINDS.MILESTONE_TASK: return EXECUTOR_FAMILIES.MILESTONE;
    case TASK_KINDS.WORKFLOW:
      return EXECUTOR_FAMILIES.PLANNING;
    case TASK_KINDS.PLANNING:
    case TASK_KINDS.REVIEW_GATE:
    case TASK_KINDS.NODE_PLANNING:
    case TASK_KINDS.GLOBAL_REVIEW:
      return EXECUTOR_FAMILIES.SUB_PLAN;
    case TASK_KINDS.ADHOC_ANALYSIS:
      return EXECUTOR_FAMILIES.ADHOC;
    case TASK_KINDS.DIAGNOSTIC:
      // Diagnostics are role sessions; the planning queue is reserved for tree orchestrators.
      return EXECUTOR_FAMILIES.SUB_PLAN;
    default: throw new Error(`unsupported task kind: ${kind}`);
  }
}

export function taskQueue(task) {
  return executorFamily(task);
}

export function executorEnvelope(task) {
  const family = executorFamily(task);
  return Object.freeze({
    id: task.id,
    projectId: task.projectId,
    family,
    queue: taskQueue(task),
    // Legacy v2 state remains unchanged until a versioned runtime migration.
    lifecycle: task.state,
    dependsOn: Object.freeze([...(task.dependsOn ?? [])]),
    parentTaskId: task.parentTaskId ?? null,
    // State is read from existing JSON-backed columns, not a new table.
    checkpoint: Object.freeze({
      stage: task.stage ?? null,
      workflowState: task.workflowState ?? null,
      execution: task.execution ?? null,
    }),
  });
}
