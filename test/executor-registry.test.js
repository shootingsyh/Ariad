import test from 'node:test';
import assert from 'node:assert/strict';
import { executorEnvelope, executorFamily, taskQueue } from '../src/v2/executor-registry.js';

test('four executor families use existing task fields', () => {
  const samples = [
    [{ id: 'm', scope: 'delivery', taskKind: 'MILESTONE_TASK' }, 'milestone'],
    [{ id: 'p', scope: 'control', taskKind: 'WORKFLOW', stage: 'tech_lead' }, 'planning'],
    [{ id: 's', scope: 'control', taskKind: 'NODE_PLANNING', stage: 'plan_validator' }, 'sub-plan'],
    [{ id: 'a', scope: 'control', taskKind: 'ADHOC_ANALYSIS', stage: 'tech_lead' }, 'adhoc'],
  ];
  for (const [task, expected] of samples) {
    assert.equal(executorFamily(task), expected);
    assert.equal(taskQueue(task), expected);
  }
});

test('legacy task envelope preserves durable state without schema migration', () => {
  const task = { id: 'p', projectId: 'proj', scope: 'control', taskKind: 'WORKFLOW',
    state: 'READY', stage: 'tech_lead', dependsOn: ['x'], workflowState: { cursor: 3 },
    execution: null };
  const envelope = executorEnvelope(task);
  assert.equal(envelope.lifecycle, 'READY');
  assert.deepEqual(envelope.checkpoint.workflowState, { cursor: 3 });
  assert.equal(envelope.checkpoint.stage, 'tech_lead');
  assert.deepEqual(envelope.dependsOn, ['x']);
  assert.equal(task.executor, undefined);
});

test('legacy planning and diagnostic tasks remain supported', () => {
  assert.equal(executorFamily({ scope: 'control', stage: 'pm' }), 'sub-plan');
  assert.equal(executorFamily({ scope: 'control', stage: 'project_debugger' }), 'sub-plan');
});

test('planning queue is exclusive to orchestration, not Pi role sessions', () => {
  assert.equal(taskQueue({ scope: 'control', taskKind: 'WORKFLOW' }), 'planning');
  assert.equal(taskQueue({ scope: 'control', taskKind: 'PLANNING' }), 'sub-plan');
  assert.equal(taskQueue({ scope: 'control', taskKind: 'REVIEW_GATE' }), 'sub-plan');
  assert.equal(taskQueue({ scope: 'control', taskKind: 'GLOBAL_REVIEW' }), 'sub-plan');
});
