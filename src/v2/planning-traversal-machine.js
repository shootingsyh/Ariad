import { defineExecutorMachine, executorStep } from './executor-dsl.js';

// The parent owns tree traversal, not LLM execution. All transitions are
// declarative; operation implementations inspect the durable tree/child state.
export const planningTraversalMachine = defineExecutorMachine({
  id: 'planning-tree-traversal',
  version: 1,
  initial: 'TRAVERSE',
  states: {
    TRAVERSE: {
      operation: 'selectNextNode',
      transitions: { NODE_FOUND: 'SPAWN', EXHAUSTED: 'COMPLETE', INVALID_TREE: 'FAILED' },
    },
    SPAWN: {
      operation: 'createChild',
      transitions: { CREATED: 'WAIT_CHILD', CREATE_FAILED: 'FAILED' },
    },
    WAIT_CHILD: {
      operation: 'observeChild',
      transitions: { CHILD_COMPLETE: 'TRAVERSE', CHILD_FAILED: 'FAILED' },
    },
    COMPLETE: {},
    FAILED: {},
  },
});

export function planningTraversalStep(state, result) {
  return executorStep(planningTraversalMachine, state, result);
}
