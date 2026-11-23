import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_CONTROL_MACHINE,
  TASK_MACHINE,
  applyTaskEvent,
  deriveProjectExecutionState,
} from '../src/v2/state-machine.js';

test('task machine rejects undeclared transitions', () => {
  assert.equal(TASK_MACHINE.resolve('READY', 'START'), 'WORKING');
  assert.equal(TASK_MACHINE.resolve('WORKING', 'COMPLETE'), 'RESULT_READY');
  assert.equal(TASK_MACHINE.resolve('SYSTEM_BLOCKED', 'RECOVER'), 'READY');
  assert.throws(
    () => TASK_MACHINE.resolve('DONE', 'START'),
    /invalid transition/,
  );
});

test('human decision target is context-driven but declared in the machine', () => {
  const task = { state: 'NEEDS_HUMAN' };
  assert.equal(applyTaskEvent(task, 'HUMAN_DECISION').state, 'READY');
  assert.equal(
    applyTaskEvent(task, 'HUMAN_DECISION', {}, { systemDiagnosis: true }).state,
    'DONE',
  );
});

test('project state is derived by ordered declarative rules', () => {
  const delivery = (state) => ({ taskKind: 'MILESTONE_TASK', state });
  assert.equal(
    deriveProjectExecutionState({ tasks: [delivery('READY')] }),
    'RUNNING',
  );
  assert.equal(
    deriveProjectExecutionState({ tasks: [delivery('SYSTEM_BLOCKED')] }),
    'FAILED',
  );
  assert.equal(
    deriveProjectExecutionState({
      tasks: [
        { ...delivery('SYSTEM_BLOCKED'), id: 'blocked' },
        {
          taskKind: 'DIAGNOSTIC',
          stage: 'project_debugger',
          state: 'WORKING',
          input: { blockedTaskId: 'blocked' },
        },
      ],
    }),
    'RUNNING',
  );
  assert.equal(
    deriveProjectExecutionState({ tasks: [delivery('NEEDS_HUMAN')] }),
    'NEEDS_HUMAN',
  );
  assert.equal(
    deriveProjectExecutionState({ tasks: [delivery('DONE')] }),
    'SUCCEEDED',
  );
  assert.equal(
    deriveProjectExecutionState({ tasks: [], hasPlanning: true }),
    'PLANNING',
  );
});


test('project control lifecycle is declared rather than hard-coded in service methods', () => {
  assert.equal(PROJECT_CONTROL_MACHINE.resolve('STOPPED', 'START'), 'RUNNING');
  assert.equal(PROJECT_CONTROL_MACHINE.resolve('RUNNING', 'PAUSE'), 'PAUSED');
  assert.equal(PROJECT_CONTROL_MACHINE.resolve('PAUSED', 'RESUME'), 'RUNNING');
  assert.equal(PROJECT_CONTROL_MACHINE.resolve('RUNNING', 'STOP'), 'STOPPED');
  assert.throws(
    () => PROJECT_CONTROL_MACHINE.resolve('STOPPED', 'PAUSE'),
    /invalid transition/,
  );
});

test('project halts when a blocked task has no diagnosis of its own', () => {
  const delivery = (state, id) => ({ taskKind: 'MILESTONE_TASK', state, id });
  const diagnosis = (blockedTaskId, state = 'WORKING') => ({
    taskKind: 'DIAGNOSTIC',
    stage: 'project_debugger',
    state,
    input: { blockedTaskId },
  });
  // One covered block: still running.
  assert.equal(
    deriveProjectExecutionState({
      tasks: [delivery('SYSTEM_BLOCKED', 'a'), diagnosis('a')],
    }),
    'RUNNING',
  );
  // A second blocked task without its own diagnosis halts the project,
  // even though another task's diagnosis is active.
  assert.equal(
    deriveProjectExecutionState({
      tasks: [delivery('SYSTEM_BLOCKED', 'a'), delivery('SYSTEM_BLOCKED', 'b'), diagnosis('a')],
    }),
    'FAILED',
  );
  // A blocked task that is not diagnosis-eligible (a diagnostic task
  // itself) neither needs coverage nor provides it.
  assert.equal(
    deriveProjectExecutionState({
      tasks: [
        delivery('SYSTEM_BLOCKED', 'a'),
        { taskKind: 'DIAGNOSTIC', stage: 'project_debugger', state: 'SYSTEM_BLOCKED', id: 'debug:a:1', input: { blockedTaskId: 'a' } },
        diagnosis('a'),
      ],
    }),
    'RUNNING',
  );
  // A planning task parked in the debugger stage is diagnosis-eligible:
  // covered it runs, uncovered it halts.
  const planning = { taskKind: 'PLANNING', stage: 'project_debugger', state: 'SYSTEM_BLOCKED', id: 'p1' };
  assert.equal(
    deriveProjectExecutionState({ tasks: [planning, diagnosis('p1')] }),
    'RUNNING',
  );
  assert.equal(
    deriveProjectExecutionState({ tasks: [planning] }),
    'FAILED',
  );
});
