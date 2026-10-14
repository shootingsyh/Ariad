import { executorStep, validateExecutorOperations } from './executor-dsl.js';

// Pure driver. Operation implementations return SIGNAL or PENDING; persistence,
// side effects, and wake-up delivery remain the host runtime's responsibility.
// Default to one transition per call so the host can durably checkpoint before\n// invoking the next operation. Explicit batching is for pure/idempotent operations.
export async function advanceExecutor({
  machine, operations, checkpoint, context, maxSteps = 1,
}) {
  validateExecutorOperations(machine, operations);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('invalid step budget');
  let state = checkpoint?.state ?? machine.initial;
  const transitions = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const spec = machine.states[state];
    if (!spec) throw new Error(`unknown executor state: ${state}`);
    if (!spec.operation) return { state, status: 'TERMINAL', transitions };
    const result = await operations[spec.operation]({
      state, context, checkpoint,
    });
    const next = executorStep(machine, state, result);
    if (next.pending) return { state, status: 'PENDING', transitions };
    transitions.push({ from: state, signal: result.signal, to: next.state });
    state = next.state;
  }
  return { state, status: 'YIELDED', transitions };
}
