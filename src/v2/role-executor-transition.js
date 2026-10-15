import { resolveExecutorSignal } from './executor-dsl.js';
import { roleExecutorBinding } from './role-executor-binding.js';

// An executor owns the transition decision. This bridge validates role
// outcomes against the machine rather than allowing arbitrary stage jumps.
// Unsupported control roles remain explicitly outside these three machines.
const STATE_TO_STAGE = Object.freeze({
  DEVELOP: 'developer', TEST_ENGINEER: 'test_engineer', TEST: 'tester',
  REVIEW: 'reviewer', UX_REVIEW: 'ux_reviewer', DEBUG: 'project_debugger',
  PLAN: 'tech_lead', VALIDATE: 'plan_validator',
  CRITIQUE: 'tech_lead_critic', ANALYZE: 'tech_lead',
});

export function executorTransitionFromResult(task, signal) {
  const binding = roleExecutorBinding(task);
  if (!binding) return null;
  const nextState = resolveExecutorSignal(binding.machine, binding.state, signal);
  const terminal = !binding.machine.states[nextState].operation;
  const state = terminal
    ? (nextState === 'FAILED' ? 'NEEDS_HUMAN' : 'DONE')
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
