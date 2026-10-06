function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function defineStateMachine({ name, transitions }) {
  if (!name) throw new Error('state machine name is required');
  if (!transitions || typeof transitions !== 'object') {
    throw new Error(`${name} transitions are required`);
  }

  const frozenTransitions = deepFreeze(transitions);
  const machine = {
    name,
    transitions: frozenTransitions,
    resolve(state, event, context = {}) {
      const rule = transitions?.[state]?.[event];
      if (!rule) {
        throw new Error(`${name}: invalid transition ${state} --${event}-->`);
      }
      const normalized = typeof rule === 'string' ? { target: rule } : rule;
      if (normalized.guard && !normalized.guard(context)) {
        throw new Error(`${name}: guard rejected ${state} --${event}-->`);
      }
      const target = typeof normalized.target === 'function'
        ? normalized.target(context)
        : normalized.target;
      if (!target) throw new Error(`${name}: transition ${state}/${event} has no target`);
      return target;
    },
  };
  return Object.freeze(machine);
}

export const TASK_MACHINE = defineStateMachine({
  name: 'AriadTask',
  transitions: {
    READY: {
      START: 'WORKING',
      SKIP: 'SKIPPED',
      OBSOLETE: 'OBSOLETE',
    },
    WORKING: {
      COMPLETE: 'RESULT_READY',
      RETRY_SYSTEM_FAILURE: 'READY',
      BLOCK_SYSTEM_FAILURE: 'SYSTEM_BLOCKED',
      CANCEL: 'READY',
    },
    RESULT_READY: {
      NEXT_ROLE: 'READY',
      FINISH: 'DONE',
      WAIT_REPLAN: 'WAITING_REPLAN',
      NEED_HUMAN: 'NEEDS_HUMAN',
      SKIP: 'SKIPPED',
    },
    WAITING_REPLAN: {
      REPLAN_READY: 'READY',
      NEED_HUMAN: 'NEEDS_HUMAN',
      OBSOLETE: 'OBSOLETE',
    },
    SYSTEM_BLOCKED: {
      RECOVER: 'READY',
      NEED_HUMAN: 'NEEDS_HUMAN',
    },
    NEEDS_HUMAN: {
      HUMAN_DECISION: {
        target: ({ systemDiagnosis = false }) => systemDiagnosis ? 'DONE' : 'READY',
      },
    },
    DONE: {},
    SKIPPED: {},
    OBSOLETE: {},
  },
});

export function applyTaskEvent(task, event, patch = {}, context = {}) {
  const target = TASK_MACHINE.resolve(task.state, event, { task, ...context });
  return {
    ...patch,
    state: target,
  };
}


export const PROJECT_CONTROL_MACHINE = defineStateMachine({
  name: 'AriadProjectControl',
  transitions: {
    STOPPED: {
      START: 'RUNNING',
      RESUME: 'RUNNING',
      STOP: 'STOPPED',
    },
    RUNNING: {
      START: 'RUNNING',
      PAUSE: 'PAUSED',
      RESUME: 'RUNNING',
      STOP: 'STOPPED',
    },
    PAUSED: {
      START: 'RUNNING',
      PAUSE: 'PAUSED',
      RESUME: 'RUNNING',
      STOP: 'STOPPED',
    },
  },
});

export const PROJECT_STATE_RULES = Object.freeze([
  {
    state: 'MIGRATING',
    when: ({ migration }) => migration?.status === 'REBUILDING',
  },
  {
    state: 'NEEDS_HUMAN',
    when: ({ tasks }) => tasks.some(task => task.state === 'NEEDS_HUMAN'),
  },
  {
    state: 'RUNNING',
    when: ({ tasks }) =>
      tasks.some(task => task.state === 'SYSTEM_BLOCKED')
      && tasks.some(task =>
        task.stage === 'project_debugger'
        && task.input?.blockedTaskId
        && ['READY', 'WORKING', 'RESULT_READY'].includes(task.state)
      ),
  },
  {
    state: 'FAILED',
    when: ({ tasks }) => tasks.some(task => task.state === 'SYSTEM_BLOCKED'),
  },
  {
    state: 'PLANNING',
    when: ({ hasPlanning }) => hasPlanning,
  },
  {
    state: 'SUCCEEDED',
    when: ({ delivery }) => delivery.length > 0
      && delivery.every(task => ['DONE', 'OBSOLETE'].includes(task.state)),
  },
  {
    state: 'RUNNING',
    when: ({ tasks }) => tasks.some(task =>
      ['READY', 'WORKING', 'RESULT_READY', 'WAITING_REPLAN'].includes(task.state)
    ),
  },
  {
    state: 'IDLE',
    when: () => true,
  },
]);

export function deriveProjectExecutionState({ tasks, hasPlanning = false, migration = null }) {
  const delivery = tasks.filter(task => task.scope === 'delivery');
  for (const rule of PROJECT_STATE_RULES) {
    if (rule.when({ tasks, delivery, hasPlanning, migration })) return rule.state;
  }
  return 'IDLE';
}
