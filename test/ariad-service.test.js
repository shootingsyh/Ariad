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

test('AriadService owns reconcile and pause/resume without OpenClaw', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-core-service-'));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const roleModels = Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'test/runtime']));
  const project = manager.create('service-project', {
    goal: 'Exercise Ariad-owned reconcile.',
    roleModels,
  });

  const seed = new SQLiteV2Store(project.stateDb);
  seed.createProject({
    id: project.id,
    spec: project.goal,
    workspace: project.workspace,
    deliveryEnabled: true,
  });
  seed.createTask({
    id: 'T-service',
    projectId: project.id,
    stage: 'developer',
    state: 'READY',
    title: 'Exercise service reconcile',
    intent: 'Complete through the default role pipeline.',
    acceptanceCriteria: [],
  });
  seed.close();

  const provider = new PydanticV2Provider(new PydanticRuntimeClient());
  const service = new AriadService({
    manager,
    provider,
    safetyIntervalMs: 60_000,
  });

  try {
    await service.start();
    await service.ensureRunning(project.id);
    await service.ensurePaused(project.id);
    await service.reconcile();

    let taskStore = new SQLiteV2Store(project.stateDb);
    let task = taskStore.getTask('T-service');
    taskStore.close();
    assert.equal(task.state, 'READY');
    assert.equal(manager.status(project.id).desiredState, 'PAUSED');

    await service.ensureResumed(project.id);
    for (let i = 0; i < 300; i += 1) {
      await service.reconcile();
      const status = service.status(project.id);
      if (status.executionState === 'SUCCEEDED') break;
      await sleep(10);
    }

    const status = service.status(project.id);
    assert.equal(status.executionState, 'SUCCEEDED');
    assert.equal(status.runtime, 'standalone');

    taskStore = new SQLiteV2Store(project.stateDb);
    task = taskStore.getTask('T-service');
    taskStore.close();
    assert.equal(task.state, 'DONE');
    assert.deepEqual(
      task.history.filter(entry => entry.type === 'ROLE_RESULT').map(entry => entry.role),
      ['developer', 'tester', 'reviewer'],
    );
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
