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
        { ...delivery('SYSTEM_BLOCKED'), id: 'blocked', diagnosisRun: { provider: 'p', externalId: 'run-1' } },
      ],
    }),
    'RUNNING',
  );
  assert.equal(
    deriveProjectExecutionState({
      tasks: [{ ...delivery('SYSTEM_BLOCKED'), history: [{ type: 'SYSTEM_DIAGNOSIS' }] }],
    }),
    'NEEDS_HUMAN',
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
  const delivery = (state, id, extra = {}) => ({ taskKind: 'MILESTONE_TASK', state, id, ...extra });
  const run = { provider: 'p', externalId: 'run-1' };
  // One covered block (the supervisor's diagnosis session is live on
  // it): still running.
  assert.equal(
    deriveProjectExecutionState({
      tasks: [delivery('SYSTEM_BLOCKED', 'a', { diagnosisRun: run })],
    }),
    'RUNNING',
  );
  // A second blocked task without a diagnosis of its own halts the
  // project, even though another task's diagnosis is active.
  assert.equal(
    deriveProjectExecutionState({
      tasks: [delivery('SYSTEM_BLOCKED', 'a', { diagnosisRun: run }), delivery('SYSTEM_BLOCKED', 'b')],
    }),
    'FAILED',
  );
  // A blocked task that is not diagnosis-eligible (a delivery task
  // parked in the debugger stage) neither needs coverage nor provides it.
  assert.equal(
    deriveProjectExecutionState({
      tasks: [
        delivery('SYSTEM_BLOCKED', 'a', { diagnosisRun: run }),
        { taskKind: 'FEATURE_TASK', stage: 'project_debugger', state: 'SYSTEM_BLOCKED', id: 't-deb' },
      ],
    }),
    'RUNNING',
  );
  // A planning task parked in the debugger stage is diagnosis-eligible:
  // covered it runs, uncovered it halts.
  const planning = { taskKind: 'PLANNING', stage: 'project_debugger', state: 'SYSTEM_BLOCKED', id: 'p1' };
  assert.equal(
    deriveProjectExecutionState({ tasks: [{ ...planning, diagnosisRun: run }] }),
    'RUNNING',
  );
  assert.equal(
    deriveProjectExecutionState({ tasks: [planning] }),
    'FAILED',
  );
});
