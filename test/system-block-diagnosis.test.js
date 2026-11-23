import assert from 'node:assert/strict';
import { test } from 'node:test';
import { V2Supervisor } from '../src/v2/supervisor.js';
import {
  autoCarryExhausted,
  diagnosisAttemptsExhausted,
  diagnosisDecidedAwaitingResume,
  diagnosisGateOpen,
  systemIncidentFromHistory,
} from '../src/v2/system-block-diagnosis.js';
import { deriveProjectExecutionState } from '../src/v2/state-machine.js';

// The supervisor manages diagnosis sessions itself (owner directive,
// 2026-11-22): no DIAGNOSTIC task is created and nothing is scheduled.
// These tests drive V2Supervisor.audit against an in-memory store, a
// fake provider and a fake session starter.

const interruption = (failure = 'provider exploded') => ({
  type: 'SYSTEM_INTERRUPTION', role: 'developer', failure,
  at: '2000-01-01T00:00:00.000Z',
});

const blockedTask = (id, extra = {}) => ({
  id, projectId: 'p', taskKind: 'FEATURE_TASK', stage: 'developer',
  state: 'SYSTEM_BLOCKED', version: 1, execution: null, input: {},
  artifacts: [], history: [interruption()], ...extra,
});

function makeStore(tasks) {
  const byId = new Map(tasks.map(t => [t.id, structuredClone(t)]));
  return {
    byId, incidents: [], planningRequests: [],
    listTasksByStates(projectId, states) {
      return [...byId.values()].filter(t => t.projectId === projectId && states.includes(t.state));
    },
    listTasksByFlow(projectId, flowId) {
      return [...byId.values()].filter(t => t.projectId === projectId && t.flowId === flowId);
    },
    listTasksByScope(projectId) {
      return [...byId.values()].filter(t => t.projectId === projectId);
    },
    listAllTasks(projectId) {
      return [...byId.values()].filter(t => t.projectId === projectId);
    },
    getTask(id) { return byId.get(id) ?? null; },
    updateTask(id, version, patch) {
      const next = { ...byId.get(id), ...patch, version: byId.get(id).version + 1 };
      byId.set(id, next);
      return next;
    },
    appendTaskHistory(id, version, entry, updated) {
      const base = updated ?? byId.get(id);
      const next = {
        ...base,
        history: [...(base.history ?? []), entry],
        version: byId.get(id).version + 1,
      };
      byId.set(id, next);
      return next;
    },
    recordIncident(incident) { this.incidents.push(incident); },
    enqueuePlanningRequest(req) { this.planningRequests.push(req); },
  };
}

function makeSupervisor(store, { poll, starter } = {}) {
  const calls = [];
  const start = starter ?? (async ({ task, attemptId }) => {
    calls.push({ taskId: task.id, attemptId });
    return { provider: 'fake', externalId: `run-${calls.length}` };
  });
  const supervisor = new V2Supervisor({
    store,
    providers: { get: () => ({ poll: poll ?? (async () => ({ state: 'RUNNING' })) }) },
    resources: { release() {}, claim: () => true, recover() {} },
    startDiagnosisSession: start,
  });
  return { supervisor, calls };
}

function seedResult(store, taskId, entry) {
  const task = store.getTask(taskId);
  store.appendTaskHistory(taskId, task.version, {
    type: 'ROLE_RESULT', source: 'role_result_tool', role: 'project_debugger',
    attemptId: task.diagnosisRun.attemptId, summary: 'diagnosed', ...entry,
  });
}

test('systemIncidentFromHistory reads the latest interruption', () => {
  const task = { stage: 'developer', history: [interruption('first'), interruption('second')] };
  const incident = systemIncidentFromHistory(task);
  assert.equal(incident.failure, 'second');
  assert.equal(incident.code, 'SYSTEM_BLOCKED');
  assert.equal(systemIncidentFromHistory({ stage: 'pm', history: [] }).failure, null);
});

test('autoCarryExhausted counts carried routes and resets on recovery', () => {
  const route = { type: 'DEBUGGER_ROUTE', autoCarried: true };
  assert.equal(autoCarryExhausted({ history: [route] }), false);
  assert.equal(autoCarryExhausted({ history: [route, route] }), true);
  assert.equal(autoCarryExhausted({ history: [route, route, { type: 'SYSTEM_RECOVERY' }] }), false);
});

test('diagnosis gate lifecycle on the blocked task history', () => {
  const gate = { type: 'SYSTEM_DIAGNOSIS' };
  const decided = { type: 'HUMAN_DECISION' };
  const recovered = { type: 'SYSTEM_RECOVERY' };
  assert.equal(diagnosisGateOpen({ history: [gate] }), true);
  assert.equal(diagnosisDecidedAwaitingResume({ history: [gate] }), false);
  assert.equal(diagnosisGateOpen({ history: [gate, decided] }), false);
  assert.equal(diagnosisDecidedAwaitingResume({ history: [gate, decided] }), true);
  assert.equal(diagnosisDecidedAwaitingResume({ history: [gate, decided, recovered] }), false);
});

test('diagnosisAttemptsExhausted bounds verdict-less session deaths', () => {
  const attempt = { type: 'SYSTEM_DIAGNOSIS_ATTEMPT' };
  assert.equal(diagnosisAttemptsExhausted({ history: [attempt, attempt] }), false);
  assert.equal(diagnosisAttemptsExhausted({ history: [attempt, attempt, attempt] }), true);
  assert.equal(
    diagnosisAttemptsExhausted({ history: [attempt, attempt, attempt, { type: 'DEBUGGER_ROUTE' }, attempt] }),
    false,
  );
});

test('supervisor starts a debugger session on the blocked task itself and creates no task', async () => {
  const store = makeStore([blockedTask('t1')]);
  const { supervisor, calls } = makeSupervisor(store);
  await supervisor.audit('p');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, 't1');
  const task = store.getTask('t1');
  assert.equal(task.diagnosisRun.externalId, 'run-1');
  assert.ok(task.history.some(e => e.type === 'SYSTEM_DIAGNOSIS_STARTED'));
  // No diagnostic task was minted: the store still holds exactly the
  // blocked task, and nothing in it is a DIAGNOSTIC task.
  assert.equal(store.listAllTasks('p').length, 1);
  assert.equal(store.listAllTasks('p').filter(t => t.taskKind === 'DIAGNOSTIC').length, 0);
});

test('at most one diagnosis session is active in a project', async () => {
  const store = makeStore([blockedTask('t1'), blockedTask('t2')]);
  const { supervisor, calls } = makeSupervisor(store);
  await supervisor.audit('p');
  await supervisor.audit('p');
  assert.equal(calls.length, 1);
  assert.ok(store.getTask('t1').diagnosisRun);
  assert.equal(store.getTask('t2').diagnosisRun, undefined);
});

test('a live diagnosis run is polled and left alone', async () => {
  const store = makeStore([blockedTask('t1')]);
  const { supervisor, calls } = makeSupervisor(store, {
    poll: async () => ({ state: 'RUNNING' }),
  });
  await supervisor.audit('p');
  await supervisor.audit('p');
  assert.equal(calls.length, 1);
  assert.equal(store.getTask('t1').diagnosisRun.externalId, 'run-1');
  assert.equal(store.getTask('t1').state, 'SYSTEM_BLOCKED');
});

test('an open operator gate occupies the diagnosis slot', async () => {
  const gated = blockedTask('t1', {
    history: [interruption(), { type: 'SYSTEM_DIAGNOSIS', diagnosis: 'SYSTEM_RUNTIME_FAILURE' }],
  });
  const store = makeStore([gated, blockedTask('t2')]);
  const { supervisor, calls } = makeSupervisor(store);
  await supervisor.audit('p');
  assert.equal(calls.length, 0);
});

test('a decided gate starts no session until the recovery lands', async () => {
  const decided = blockedTask('t1', {
    history: [
      interruption(),
      { type: 'SYSTEM_DIAGNOSIS', diagnosis: 'SYSTEM_RUNTIME_FAILURE' },
      { type: 'HUMAN_DECISION', decision: 'approved' },
    ],
  });
  const store = makeStore([decided]);
  const { supervisor, calls } = makeSupervisor(store);
  await supervisor.audit('p');
  assert.equal(calls.length, 0);
});

test('a RETRY_WITH_GUIDANCE verdict routes the blocked task onward', async () => {
  const store = makeStore([blockedTask('t1')]);
  const { supervisor } = makeSupervisor(store, {
    poll: async () => ({ state: 'COMPLETED' }),
  });
  await supervisor.audit('p');
  seedResult(store, 't1', { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'check the provider config' } });
  await supervisor.audit('p');
  const task = store.getTask('t1');
  assert.equal(task.state, 'READY');
  assert.equal(task.stage, 'developer');
  assert.equal(task.diagnosisRun, null);
  const route = task.history.find(e => e.type === 'DEBUGGER_ROUTE');
  assert.equal(route.diagnosis, 'RETRY_WITH_GUIDANCE');
  assert.equal(route.guidance, 'check the provider config');
  assert.equal(route.source, 'system_block_diagnosis');
});

test('an auto-carried runtime verdict retries the task without a gate', async () => {
  const store = makeStore([blockedTask('t1')]);
  const { supervisor } = makeSupervisor(store, {
    poll: async () => ({ state: 'COMPLETED' }),
  });
  await supervisor.audit('p');
  seedResult(store, 't1', { outcome: 'SYSTEM_RUNTIME_FAILURE', result: { reason: 'daemon restarted' } });
  await supervisor.audit('p');
  const task = store.getTask('t1');
  assert.equal(task.state, 'READY');
  const route = task.history.find(e => e.type === 'DEBUGGER_ROUTE');
  assert.equal(route.autoCarried, true);
  assert.equal(task.history.some(e => e.type === 'SYSTEM_DIAGNOSIS'), false);
});

test('an operator-required verdict parks the gate on the blocked task itself', async () => {
  const store = makeStore([blockedTask('t1')]);
  const { supervisor, calls } = makeSupervisor(store, {
    poll: async () => ({ state: 'COMPLETED' }),
  });
  await supervisor.audit('p');
  seedResult(store, 't1', {
    outcome: 'SYSTEM_RUNTIME_FAILURE',
    result: { operatorRequired: true, reason: 'runtime policy is broken' },
  });
  await supervisor.audit('p');
  const task = store.getTask('t1');
  assert.equal(task.state, 'SYSTEM_BLOCKED');
  assert.equal(task.diagnosisRun, null);
  const gate = task.history.find(e => e.type === 'SYSTEM_DIAGNOSIS');
  assert.ok(gate);
  assert.equal(gate.diagnosis, 'SYSTEM_RUNTIME_FAILURE');
  assert.ok(Array.isArray(gate.questions) && gate.questions.length > 0);
  // The project waits at the human gate, and no new session starts
  // while the gate is open.
  assert.equal(deriveProjectExecutionState({ tasks: store.listAllTasks('p') }), 'NEEDS_HUMAN');
  await supervisor.audit('p');
  assert.equal(calls.length, 1);
});

test('a planning task verdict routes it back to its planning stage', async () => {
  const planning = blockedTask('p1', {
    taskKind: 'PLANNING', stage: 'project_debugger', input: { purpose: 'PLANNER_TASK_SPLIT' },
  });
  const store = makeStore([planning]);
  const { supervisor } = makeSupervisor(store, {
    poll: async () => ({ state: 'COMPLETED' }),
  });
  await supervisor.audit('p');
  seedResult(store, 'p1', { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'split it' } });
  await supervisor.audit('p');
  const task = store.getTask('p1');
  assert.equal(task.state, 'READY');
  assert.equal(task.stage, 'tech_lead');
});

test('sessions that die without a verdict are retried, then the supervisor stops', async () => {
  const store = makeStore([blockedTask('t1')]);
  const { supervisor, calls } = makeSupervisor(store, {
    poll: async () => ({ state: 'LOST', failure: 'session gone' }),
  });
  for (let i = 0; i < 7; i += 1) await supervisor.audit('p');
  assert.equal(calls.length, 3);
  const task = store.getTask('t1');
  assert.equal(task.state, 'SYSTEM_BLOCKED');
  assert.equal(task.diagnosisRun, null);
  assert.equal(task.history.filter(e => e.type === 'SYSTEM_DIAGNOSIS_ATTEMPT').length, 3);
  // With no live session and the attempt budget spent, the project halts.
  assert.equal(deriveProjectExecutionState({ tasks: store.listAllTasks('p') }), 'FAILED');
});

test('a provider-terminal verdict rides on the poll status itself', async () => {
  const store = makeStore([blockedTask('t1')]);
  const { supervisor } = makeSupervisor(store, {
    poll: async () => ({
      state: 'COMPLETED', outcome: 'RETRY_WITH_GUIDANCE', summary: 'diagnosed',
      result: { guidance: 'restart the session host' },
    }),
  });
  await supervisor.audit('p');
  await supervisor.audit('p');
  const task = store.getTask('t1');
  assert.equal(task.state, 'READY');
  const route = task.history.find(e => e.type === 'DEBUGGER_ROUTE');
  assert.equal(route.guidance, 'restart the session host');
});
