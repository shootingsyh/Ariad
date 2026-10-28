import { effectiveTaskKind, isDeliveryKind, TASK_KINDS } from './control-task-policy.js';
import { milestoneMachine, subPlanMachine, adhocMachine, planMachine } from './role-executor-machines.js';

// Boundary between persisted v2 role names and executor-owned DSL states.
// Do not infer success from a role name: the role result is evaluated by the
// owning executor, and only then produces a transition signal.
const MILESTONE_STAGES = Object.freeze({
  developer: 'DEVELOP', test_engineer: 'TEST_ENGINEER',
  tester: 'TEST', reviewer: 'REVIEW', ux_reviewer: 'UX_REVIEW', artist: 'ARTIST', pm: 'PM', project_debugger: 'DEBUG',
});
const SUB_PLAN_STAGES = Object.freeze({
  tech_lead: 'PLAN', plan_validator: 'VALIDATE',
  tech_lead_critic: 'CRITIQUE', project_debugger: 'DEBUG',
});
const ADHOC_STAGES = Object.freeze({ tech_lead: 'ANALYZE' });
const PLAN_STAGES = Object.freeze({
  tech_lead: 'PLAN', plan_validator: 'VALIDATE',
  tech_lead_critic: 'CRITIQUE', pm: 'PM_REVIEW',
  feature_planner: 'FEATURE_PLAN', milestone_planner: 'MILESTONE_PLAN',
  interface_architect: 'INTERFACE_PLAN', project_debugger: 'DEBUG',
});

export function roleExecutorBinding(task) {
  const kind = effectiveTaskKind(task);
  let machine, stages;
  if (isDeliveryKind(kind)) {
    machine = milestoneMachine; stages = MILESTONE_STAGES;
  } else if (kind === TASK_KINDS.ADHOC_ANALYSIS) {
    machine = adhocMachine; stages = ADHOC_STAGES;
  } else if (kind === TASK_KINDS.NODE_PLANNING || kind === TASK_KINDS.GLOBAL_REVIEW) {
    machine = subPlanMachine; stages = SUB_PLAN_STAGES;
  } else if (kind === TASK_KINDS.PLANNING) {
    machine = planMachine; stages = PLAN_STAGES;
  } else {
    // PM gates and diagnostic control tasks have different contracts.
    // They must be modeled explicitly rather than forced into a wrong machine.
    return null;
  }
  const state = stages[task.stage];
  if (!state) throw new Error(`UNSUPPORTED_EXECUTOR_ROLE:${machine.id}/${task.stage}`);
  return Object.freeze({ machine, state });
}
