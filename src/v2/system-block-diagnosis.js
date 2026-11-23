import { TASK_KINDS, openDiagnosisGate } from './control-task-policy.js';
import { debuggerAutoCarries, DEBUGGER_AUTO_CARRY_LIMIT } from './milestone-result-executor.js';

// System-block diagnosis, supervisor-managed (owner directive,
// 2026-11-22). A delivery or planning task frozen in SYSTEM_BLOCKED by
// a system failure (provider/session failure in the supervisor or
// scheduler) cannot escalate itself into the project debugger the way
// a role-flow failure can: it is frozen in place. The previous design
// parked a separate DIAGNOSTIC task next to it and let the scheduler
// dispatch it - which made the cure share the disease: the diagnostic
// tasks were orphaned, starved and re-minted by the very runtime
// failures they existed to diagnose (48 accumulated in one day). The
// supervisor now runs the debugger session itself: it starts a
// project_debugger session directly on the blocked task (the run
// handle is persisted on the blocked task as diagnosisRun), polls it
// in its audit, and applies the verdict to the blocked task through
// the same transition function the dispatched flow used. No task is
// created and nothing enters the dispatch pool. At most one diagnosis
// session is active in a project at a time; a second blocked task gets
// no session and the project-state derivation halts the project
// (FAILED) for the operator instead of fanning out.

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

// The debugger's runtime-failure verdicts are auto-carried back into
// the blocked task only up to DEBUGGER_AUTO_CARRY_LIMIT consecutive
// times. That counter lives on the blocked task's own history (where
// the DEBUGGER_ROUTE entries land). A manual recovery (SYSTEM_RECOVERY)
// is the operator's decision to retry and resets the count, like a
// HUMAN_DECISION does in debuggerAutoCarries itself.
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

// A system diagnosis that ends with an operator-required verdict
// records a SYSTEM_DIAGNOSIS gate entry on the blocked task itself.
// While the gate is open the operator is already being asked, so no
// new session starts; once the operator decides, the decision hands
// the block to the operator's resume (which writes SYSTEM_RECOVERY),
// so no new session starts until that recovery lands either - a fresh
// session before it only repeats the same verdict on the same
// evidence.
export function diagnosisGateOpen(task) {
  return openDiagnosisGate(task) != null;
}

export function diagnosisDecidedAwaitingResume(task) {
  const history = task?.history ?? [];
  let gateAt = -1;
  let decidedAt = -1;
  let recoveredAt = -1;
  for (let i = 0; i < history.length; i += 1) {
    if (history[i]?.type === 'SYSTEM_DIAGNOSIS') gateAt = i;
    if (history[i]?.type === 'HUMAN_DECISION') decidedAt = i;
    if (history[i]?.type === 'SYSTEM_RECOVERY') recoveredAt = i;
  }
  return gateAt >= 0 && decidedAt > gateAt && recoveredAt < decidedAt;
}

// Sessions that die without a verdict (the provider lost the run, the
// session ended without submitting) are retried by the supervisor, but
// only a bounded number of times in a row: a diagnosis that keeps
// dying is itself a runtime failure, and the block then waits for the
// operator with the project halted instead of minting sessions
// forever. A verdict (DEBUGGER_ROUTE), a human decision or an operator
// recovery resets the count.
export const DIAGNOSIS_SESSION_ATTEMPT_LIMIT = 3;

export function diagnosisAttemptsExhausted(task) {
  let attempts = 0;
  const history = task?.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const type = history[i]?.type;
    if (type === 'DEBUGGER_ROUTE' || type === 'SYSTEM_RECOVERY' || type === 'HUMAN_DECISION') break;
    if (type === 'SYSTEM_DIAGNOSIS_ATTEMPT') attempts += 1;
  }
  return attempts >= DIAGNOSIS_SESSION_ATTEMPT_LIMIT;
}

// The blocked-task view the debugger verdict transition consumes. The
// transition function was written for a separate diagnostic task, so
// the supervisor presents the blocked task in that shape: its own
// history carries the DEBUGGER_ROUTE / auto-carry record the
// transition reads, and the input carries the blocked-task snapshot
// the routing keys off.
export function diagnosisTaskView(task) {
  return {
    ...task,
    taskKind: TASK_KINDS.DIAGNOSTIC,
    stage: 'project_debugger',
    input: {
      blockedTaskId: task.id,
      blockedTaskKind: task.taskKind,
      blockedTaskPurpose: task.input?.purpose ?? null,
      systemIncident: systemIncidentFromHistory(task),
    },
  };
}
