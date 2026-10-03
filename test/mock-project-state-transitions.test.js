import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AriadService } from '../src/runtime/ariad-service.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { ARIAD_MODEL_ROLES } from '../src/runtime/role-models.js';
import { PydanticRuntimeClient, PydanticV2Provider } from '../src/runtime/pydantic-v2-provider.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createMockProject(prefix = 'ariad-mock-state-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const roleModels = Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'test/runtime']));
  const project = manager.create('mock-project', {
    goal: 'Exercise Ariad state transitions.',
    roleModels,
  });

  const store = new SQLiteV2Store(project.stateDb);
  store.createProject({
    id: project.id,
    spec: project.goal,
    workspace: project.workspace,
    deliveryEnabled: true,
  });
  store.createTask({
    id: 'T-mock',
    projectId: project.id,
    stage: 'developer',
    state: 'READY',
    title: 'Mock state transition task',
    intent: 'Exercise realistic lifecycle transitions.',
    acceptanceCriteria: [],
  });
  store.close();

  return { root, manager, project };
}

async function reconcileUntil(service, projectId, predicate, limit = 500) {
  const snapshots = [];
  for (let i = 0; i < limit; i += 1) {
    await service.reconcile();
    const status = service.status(projectId);
    const store = new SQLiteV2Store(status.stateDb);
    const task = store.getTask('T-mock');
    store.close();
    snapshots.push({
      projectState: status.executionState,
      desiredState: status.desiredState,
      stage: task.stage,
      state: task.state,
    });
    if (predicate({ status, task, snapshots })) return { status, task, snapshots };
    await sleep(10);
  }
  throw new Error(`condition not reached; last=${JSON.stringify(snapshots.at(-1))}`);
}

test('mock project retries business failure through developer and then succeeds', async () => {
  const { root, manager, project } = createMockProject('ariad-mock-business-');
  const roleStarts = [];
  let testerRuns = 0;

  const provider = new PydanticV2Provider(new PydanticRuntimeClient(), {
    resolveModelRef: (_projectId, role) => `test/${role}`,
    resolveModelConfig: (_modelRef, context) => {
      roleStarts.push(context.role);
      if (context.role === 'tester') {
        testerRuns += 1;
        return {
          kind: 'test',
          model: 'tester',
          outcome: testerRuns === 1 ? 'NOT_PASS' : 'PASS',
          summary: testerRuns === 1 ? 'Mock verification failed.' : 'Mock verification passed.',
        };
      }
      return {
        kind: 'test',
        model: context.role,
        outcome: 'PASS',
        summary: `Mock ${context.role} completed.`,
      };
    },
  });

  const service = new AriadService({ manager, provider, safetyIntervalMs: 60_000 });

  try {
    await service.ensureRunning(project.id);

    const { status, task, snapshots } = await reconcileUntil(
      service,
      project.id,
      ({ status }) => status.executionState === 'SUCCEEDED',
    );

    assert.equal(status.executionState, 'SUCCEEDED');
    assert.equal(task.state, 'DONE');
    assert.equal(task.stage, 'reviewer');

    const roleResults = task.history.filter(entry => entry.type === 'ROLE_RESULT');
    assert.deepEqual(
      roleResults.map(entry => [entry.role, entry.outcome]),
      [
        ['developer', 'PASS'],
        ['tester', 'NOT_PASS'],
        ['developer', 'PASS'],
        ['tester', 'PASS'],
        ['reviewer', 'PASS'],
      ],
    );
    assert.deepEqual(roleStarts, ['developer', 'tester', 'developer', 'tester', 'reviewer']);

    assert.ok(snapshots.some(s => s.stage === 'developer' && s.state === 'WORKING'));
    assert.ok(snapshots.some(s => s.stage === 'tester'));
    assert.ok(snapshots.some(s => s.stage === 'reviewer'));
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mock project blocks after repeated runtime failures and resume requeues it', async () => {
  const { root, manager, project } = createMockProject('ariad-mock-recovery-');
  let developerRuns = 0;

  const provider = new PydanticV2Provider(new PydanticRuntimeClient(), {
    resolveModelRef: (_projectId, role) => `test/${role}`,
    resolveModelConfig: (_modelRef, context) => {
      if (context.role === 'developer') {
        developerRuns += 1;
        if (developerRuns <= 3) {
          return {
            kind: 'test',
            model: 'developer',
            scenario: 'empty-always',
          };
        }
      }
      return {
        kind: 'test',
        model: context.role,
        outcome: 'PASS',
        summary: `Recovered ${context.role} completed.`,
      };
    },
  });

  const service = new AriadService({ manager, provider, safetyIntervalMs: 60_000 });

  try {
    await service.ensureRunning(project.id);

    const failed = await reconcileUntil(
      service,
      project.id,
      ({ status }) => status.executionState === 'FAILED',
    );

    assert.equal(failed.task.state, 'SYSTEM_BLOCKED');
    assert.equal(failed.task.stage, 'developer');
    assert.equal(developerRuns, 3);
    assert.equal(
      failed.task.history.filter(entry => entry.type === 'SYSTEM_INTERRUPTION').length,
      3,
    );

    const resumed = await service.ensureResumed(project.id);
    assert.deepEqual(resumed.recoveredTasks, ['T-mock']);

    const afterResumeStore = new SQLiteV2Store(project.stateDb);
    const afterResume = afterResumeStore.getTask('T-mock');
    afterResumeStore.close();
    assert.equal(afterResume.state, 'READY');
    assert.equal(afterResume.stage, 'developer');
    assert.equal(
      afterResume.history.filter(entry => entry.type === 'SYSTEM_RECOVERY').length,
      1,
    );

    const recovered = await reconcileUntil(
      service,
      project.id,
      ({ status }) => status.executionState === 'SUCCEEDED',
    );

    assert.equal(recovered.task.state, 'DONE');
    assert.equal(recovered.status.executionState, 'SUCCEEDED');
    assert.deepEqual(
      recovered.task.history
        .filter(entry => entry.type === 'ROLE_RESULT')
        .map(entry => [entry.role, entry.outcome]),
      [
        ['developer', 'PASS'],
        ['tester', 'PASS'],
        ['reviewer', 'PASS'],
      ],
    );
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
