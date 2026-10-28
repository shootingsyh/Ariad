import { resolveExecutorSignal } from './executor-dsl.js';
import { roleExecutorBinding } from './role-executor-binding.js';

// An executor owns the transition decision. This bridge validates role
// outcomes against the machine rather than allowing arbitrary stage jumps.
// Unsupported control roles remain explicitly outside these three machines.
const STATE_TO_STAGE = Object.freeze({
  DEVELOP: 'developer', TEST_ENGINEER: 'test_engineer', TEST: 'tester',
  REVIEW: 'reviewer', UX_REVIEW: 'ux_reviewer', DEBUG: 'project_debugger',
  ARTIST: 'artist', PM: 'pm',
  PLAN: 'tech_lead', VALIDATE: 'plan_validator',
  CRITIQUE: 'tech_lead_critic', ANALYZE: 'tech_lead',
  PM_REVIEW: 'pm', FEATURE_PLAN: 'feature_planner',
  MILESTONE_PLAN: 'milestone_planner', INTERFACE_PLAN: 'interface_architect',
});

const PLANNING_MACHINE_IDS = new Set(['plan-executor', 'sub-plan-executor']);

export function executorTransitionFromResult(task, signal) {
  const binding = roleExecutorBinding(task);
  if (!binding) return null;
  const nextState = resolveExecutorSignal(binding.machine, binding.state, signal);
  const terminal = !binding.machine.states[nextState].operation;
  // Escalation whitelist: a FAILED planning executor is reachable only
  // after its retries and debugger are exhausted, so it surfaces as a
  // system block (channel: system dead, operator-recoverable), not a
  // per-task human decision. Delivery machines keep NEEDS_HUMAN: their
  // FAILED carries the system-diagnosis close-out semantics.
  const failedState = PLANNING_MACHINE_IDS.has(binding.machine.id) ? 'SYSTEM_BLOCKED' : 'NEEDS_HUMAN';
  const state = terminal
    ? (nextState === 'FAILED' ? failedState
      : nextState === 'HUMAN_GATE' ? 'NEEDS_HUMAN'
      : nextState === 'REPLAN_PENDING' ? 'WAITING_REPLAN' : 'DONE')
    : 'READY';
  return Object.freeze({
    machineId: binding.machine.id,
    from: binding.state,
    signal,
    to: nextState,
    patch: Object.freeze({
      state,
      ...(terminal ? {} : { stage: STATE_TO_STAGE[nextState] }),
    }),
  });
}
