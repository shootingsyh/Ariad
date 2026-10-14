// Minimal declarative executor state machine.
// A machine describes only state, operation and signal -> next-state transitions.
// Operations live in a separate registry and never choose their own next state.
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function defineExecutorMachine({ id, version = 1, initial, states }) {
  if (typeof id !== 'string' || !id) throw new Error('machine id is required');
  if (!Number.isInteger(version) || version < 1) throw new Error('machine version must be positive');
  if (!states || typeof states !== 'object' || Array.isArray(states)) throw new Error('states are required');
  if (!own(states, initial)) throw new Error(`unknown initial state: ${initial}`);
  const normalized = Object.create(null);
  for (const [name, spec] of Object.entries(states)) {
    if (!name || !spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`invalid state: ${name}`);
    if (Object.keys(spec).some(key => !['operation', 'transitions'].includes(key))) {
      throw new Error(`unsupported DSL field in state ${name}`);
    }
    const transitions = spec.transitions ?? {};
    if (!transitions || typeof transitions !== 'object' || Array.isArray(transitions)) throw new Error(`invalid transitions: ${name}`);
    const terminal = !own(spec, 'operation');
    if (terminal && Object.keys(transitions).length) throw new Error(`terminal state has transitions: ${name}`);
    if (!terminal && (typeof spec.operation !== 'string' || !spec.operation || !Object.keys(transitions).length)) {
      throw new Error(`nonterminal state needs operation and transitions: ${name}`);
    }
    normalized[name] = Object.freeze({ operation: spec.operation ?? null, transitions: Object.freeze({ ...transitions }) });
  }
  for (const [name, spec] of Object.entries(normalized)) {
    for (const [signal, target] of Object.entries(spec.transitions)) {
      if (!signal || typeof target !== 'string' || !own(normalized, target)) {
        throw new Error(`invalid transition: ${name}/${signal} -> ${target}`);
      }
    }
  }
  return Object.freeze({ id, version, initial, states: Object.freeze(normalized) });
}

// Pure transition resolver; storage, event delivery and effects are runtime responsibilities.
export function resolveExecutorSignal(machine, state, signal) {
  const spec = machine.states[state];
  if (!spec) throw new Error(`unknown executor state: ${state}`);
  if (!spec.operation) throw new Error(`terminal executor state: ${state}`);
  if (!own(spec.transitions, signal)) throw new Error(`unexpected signal: ${state}/${signal}`);
  return spec.transitions[signal];
}

export function executorStep(machine, state, result) {
  if (result?.status === 'PENDING') return Object.freeze({ state, pending: true });
  if (result?.status !== 'SIGNAL' || typeof result.signal !== 'string') {
    throw new Error('operation must return PENDING or SIGNAL');
  }
  return Object.freeze({ state: resolveExecutorSignal(machine, state, result.signal), pending: false });
}

export function validateExecutorOperations(machine, registry) {
  for (const [name, spec] of Object.entries(machine.states)) {
    if (spec.operation && typeof registry?.[spec.operation] !== 'function') {
      throw new Error(`unregistered operation: ${name}/${spec.operation}`);
    }
  }
  return true;
}
