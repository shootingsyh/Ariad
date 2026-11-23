import { TASK_KINDS, isDiagnosisEligible } from './control-task-policy.js';
import { debuggerAutoCarries, DEBUGGER_AUTO_CARRY_LIMIT } from './milestone-result-executor.js';

// A delivery task that reaches SYSTEM_BLOCKED through the system path
// (provider/session failure in the supervisor or scheduler) cannot escalate
// itself into the project debugger the way a role-flow failure can: it is
// frozen in place. A PLANNING task lands in the same state from the other
// direction: its own in-flow debugger's terminal diagnosis is mapped to
// SYSTEM_BLOCKED by design (never a per-task human decision), on the
// assumption that this system-level sweep picks it up. The rest of the
// diagnosis machinery (control-task policy, unified dispatch, blocked-task
// routing transitions, FAILED suppression while a diagnosis is active)
// already supports a separate DIAGNOSTIC task carrying
// { blockedTaskId, systemIncident }; this module is the missing creation
// step. It is idempotent: an active diagnosis is never duplicated, and a
// task that blocks again after a completed diagnosis gets the next
// sequence number. The blocked task's kind and planning purpose are
// snapshotted into the diagnosis input so the result executor can route
// a planning task back to its own planning stage instead of a delivery
// stage.

// A diagnosis parked at NEEDS_HUMAN is still open: it is waiting on the
// operator, and a duplicate would only race the gate.
const ACTIVE_DIAGNOSIS_STATES = new Set(['READY', 'WORKING', 'RESULT_READY', 'NEEDS_HUMAN']);

// At most one diagnosis may be active in a project at a time (owner
// directive, 2026-11-22): parallel diagnoses were the visible symptom of
// a systemic failure, and an army of debugger sessions racing the same
// broken runtime only multiplied provider errors. A blocked task that
// would need a second concurrent diagnosis gets none; it is reported in
// the sweep's excess list, and because it stays blocked without an
// active diagnosis the project-state derivation halts the project
// (FAILED) for the operator instead of fanning out.
const ACTIVE_DIAGNOSIS_LIMIT = 1;

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

// A system diagnosis closed by a human decision hands the block to the
// operator: the decision marks the project FAILED and the operator's
// resume performs the recovery (SYSTEM_RECOVERY on the blocked task).
// Creating the next diagnosis before that resume only repeats the same
// verdict on the same evidence, and an active diagnosis suppresses the
// FAILED state the resume path keys on - the decision is discarded and
// the block loops through identical diagnoses. Hold off until the
// recovery lands.
export function diagnosisDecidedAwaitingResume(task, diagnoses) {
  const decided = diagnoses.filter(
    d => d.state === 'DONE' && (d.history ?? []).some(e => e?.type === 'HUMAN_DECISION'),
  ).at(-1);
  if (!decided) return false;
  const decidedAt = [...(decided.history ?? [])].reverse()
    .find(e => e?.type === 'HUMAN_DECISION')?.at ?? null;
  if (!decidedAt) return false;
  return !(task.history ?? []).some(
    e => e?.type === 'SYSTEM_RECOVERY' && (e.at ?? '') > decidedAt,
  );
}

export function ensureSystemBlockDiagnosis(store, projectId) {
  const tasks = store.listTasks(projectId);
  const diagnoses = tasks.filter(
    task => task.taskKind === TASK_KINDS.DIAGNOSTIC && task.input?.blockedTaskId,
  );
  const created = [];
  const failures = [];
  const excess = [];
  const activeDiagnoses = diagnoses.filter(d => ACTIVE_DIAGNOSIS_STATES.has(d.state));
  for (const task of tasks) {
    if (!isDiagnosisEligible(task)) continue;
    if (autoCarryExhausted(task)) continue;
    const mine = diagnoses.filter(d => d.input.blockedTaskId === task.id);
    if (mine.some(d => ACTIVE_DIAGNOSIS_STATES.has(d.state))) continue;
    if (diagnosisDecidedAwaitingResume(task, mine)) continue;
    if (activeDiagnoses.length >= ACTIVE_DIAGNOSIS_LIMIT) {
      excess.push({
        taskId: task.id,
        activeDiagnosisId: activeDiagnoses[0].id,
        failure: `CONCURRENT_DIAGNOSIS_LIMIT: task ${task.id} needs a system-block diagnosis while ${activeDiagnoses[0].id} is still active; at most ${ACTIVE_DIAGNOSIS_LIMIT} diagnosis may be active at a time, so none is created and the project halts until the active diagnosis resolves`,
      });
      continue;
    }
    const id = `debug:${task.id}:${mine.length + 1}`;
    if (store.getTask(id)) continue;
    try {
      const diagnosis = store.createTask({
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
          blockedTaskKind: task.taskKind,
          blockedTaskPurpose: task.input?.purpose ?? null,
          systemIncident: systemIncidentFromHistory(task),
        },
        version: 1,
      });
      created.push(diagnosis);
      activeDiagnoses.push(diagnosis);
    } catch (error) {
      failures.push({
        taskId: task.id,
        failure: `SYSTEM_BLOCK_DIAGNOSIS_FAILED: ${error?.message ?? String(error)}`,
      });
    }
  }
  return { created, failures, excess };
}
