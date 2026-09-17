import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraph } from '../src/task-graph.js';
import { WorkBuilder } from '../src/work-builder.js';

test('state context cannot override canonical task and workflow cursor fields', () => {
  const graph = new TaskGraph([{ id: 'T1', dependsOn: [] }]);
  const stateStore = {
    get(id) {
      assert.equal(id, 'T1');
      return {
        taskId: 'T1',
        stage: 'developer',
        devCycle: 2,
        strategyEpoch: 3,
        status: 'RUNNING',
        context: {
          taskId: 'WRONG',
          devCycle: 99,
          strategyEpoch: 88,
          goal: 'keep this user context',
        },
      };
    },
  };
  const builder = new WorkBuilder({
    graph,
    stateStore,
    roleRuntimeMap: { developer: 'local' },
  });

  const [work] = builder.buildReady();
  assert.equal(work.context.goal, 'keep this user context');
  assert.equal(work.context.taskId, 'T1');
  assert.equal(work.context.devCycle, 2);
  assert.equal(work.context.strategyEpoch, 3);
});
