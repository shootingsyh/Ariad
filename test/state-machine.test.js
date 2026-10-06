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
  const delivery = (state) => ({ scope: 'delivery', state });
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
          scope: 'control',
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
  assert.equal(
    deriveProjectExecutionState({
      tasks: [{ scope: 'control', state: 'NEEDS_HUMAN' }],
      hasPlanning: true,
      migration: { status: 'REBUILDING' },
    }),
    'MIGRATING',
  );
  assert.equal(
    deriveProjectExecutionState({
      tasks: [{ scope: 'delivery', state: 'READY' }],
      migration: { status: 'REBUILDING' },
    }),
    'MIGRATING',
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
