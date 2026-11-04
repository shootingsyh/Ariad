import { TASK_KINDS, isDeliveryKind } from './control-task-policy.js';
import { debuggerAutoCarries, DEBUGGER_AUTO_CARRY_LIMIT } from './milestone-result-executor.js';

// A delivery task that reaches SYSTEM_BLOCKED through the system path
// (provider/session failure in the supervisor or scheduler) cannot escalate
// itself into the project debugger the way a role-flow failure can: it is
// frozen in place. The rest of the diagnosis machinery (control-task
// policy, unified dispatch, blocked-task routing transitions, FAILED
// suppression while a diagnosis is active) already supports a separate
// DIAGNOSTIC task carrying { blockedTaskId, systemIncident }; this module
// is the missing creation step. It is idempotent: an active diagnosis is
// never duplicated, and a task that blocks again after a completed
// diagnosis gets the next sequence number.

const ACTIVE_DIAGNOSIS_STATES = new Set(['READY', 'WORKING', 'RESULT_READY']);

export function systemIncidentFromHistory(task) {
  const history = task?.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type === 'SYSTEM_INTERRUPTION') {
      return {
        code: 'SYSTEM_BLOCKED',
        failure: entry.failure ?? null,
        role: entry.role ?? task.stage ?? null,
        consumeAttempt: entry.consumeAttempt !== false,
        at: entry.at ?? null,
      };
    }
  }
  return { code: 'SYSTEM_BLOCKED', failure: null, role: task?.stage ?? null, at: null };
}

// The debugger's runtime-failure verdicts are auto-carried back into the
// blocked task only up to DEBUGGER_AUTO_CARRY_LIMIT consecutive times.
// That counter lives on the diagnostic task in the executor, so a fresh
// diagnostic task per block would reset it and loop forever; mirror the
// limit here, on the blocked task's own history (where the blockedRoute
// entries land). A manual recovery (SYSTEM_RECOVERY) is the operator's
// decision to retry and resets the count, like a HUMAN_DECISION does in
// debuggerAutoCarries itself.
export function autoCarryExhausted(task) {
  const history = task?.history ?? [];
  let lastRoute = -1;
  let lastRecovery = -1;
  for (let i = 0; i < history.length; i += 1) {
    if (history[i]?.type === 'DEBUGGER_ROUTE' && history[i]?.autoCarried === true) lastRoute = i;
    if (history[i]?.type === 'SYSTEM_RECOVERY') lastRecovery = i;
  }
  if (lastRecovery > lastRoute) return false;
  return debuggerAutoCarries(task) >= DEBUGGER_AUTO_CARRY_LIMIT;
}

export function ensureSystemBlockDiagnosis(store, projectId) {
  const tasks = store.listTasks(projectId);
  const diagnoses = tasks.filter(
    task => task.taskKind === TASK_KINDS.DIAGNOSTIC && task.input?.blockedTaskId,
  );
  const created = [];
  const failures = [];
  for (const task of tasks) {
    if (task.state !== 'SYSTEM_BLOCKED') continue;
    if (!isDeliveryKind(task.taskKind)) continue;
    if (task.stage === 'project_debugger') continue;
    if (autoCarryExhausted(task)) continue;
    const mine = diagnoses.filter(d => d.input.blockedTaskId === task.id);
    if (mine.some(d => ACTIVE_DIAGNOSIS_STATES.has(d.state))) continue;
    const id = `debug:${task.id}:${mine.length + 1}`;
    if (store.getTask(id)) continue;
    try {
      created.push(store.createTask({
        id,
        projectId,
        scope: 'control',
        flowId: `diagnostic:${projectId}`,
        taskKind: TASK_KINDS.DIAGNOSTIC,
        stage: 'project_debugger',
        state: 'READY',
        title: `Diagnose system-blocked task ${task.id}`,
        input: {
          blockedTaskId: task.id,
          systemIncident: systemIncidentFromHistory(task),
        },
        version: 1,
      }));
    } catch (error) {
      failures.push({
        taskId: task.id,
        failure: `SYSTEM_BLOCK_DIAGNOSIS_FAILED: ${error?.message ?? String(error)}`,
      });
    }
  }
  return { created, failures };
}
