import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { AriadService } from '../src/runtime/ariad-service.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { ARIAD_MODEL_ROLES } from '../src/runtime/role-models.js';
import { LOCAL_REPLAN_GUIDANCE } from '../src/runtime/standalone-project-runtime.js';
import { plannerFlowTasks, createNextPlanningBatch, usesThreePassFlow } from '../src/v2/planner-flow.js';
import { plannerPrompt } from '../src/v2/role-prompts.js';

// Local replan (owner decision, 2026-11-02): the operator entrance that
// actualizes an owner decision as a bounded planning request. Unlike
// analyze it is not read-only; unlike begin-iteration it never stops or
// archives the project.

test('operator replan enqueues a PENDING LOCAL_REPLAN request with the boundary guidance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-local-replan-'));
  const manager = new AriadProjectManager({ projectsRoot: root });
  const project = manager.create('replan-probe', {
    goal: 'Verify the local replan entrance',
    roleModels: Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'test/runtime'])),
  });
  const service = new AriadService({
    manager,
    provider: {
      id: 'fake',
      start: async () => ({ externalId: 'fake-run' }),
      poll: async () => ({ state: 'RUNNING' }),
      cancel: async () => {},
      close: async () => {},
    },
    memoryCurator: { close: async () => {} },
  });
  try {
    const result = service.createOperatorReplan(project.id, {
      id: 'operator-test',
      instruction: 'Amend the battle presentation tasks per the owner decision.',
    });
    assert.equal(result.projectId, project.id);
    assert.equal(result.purpose, 'LOCAL_REPLAN');
    assert.equal(result.state, 'PENDING');
    assert.match(result.requestId, /:local-replan:operator-test:\d+$/);

    const store = new SQLiteV2Store(project.stateDb);
    try {
      const requests = store.listPlanningRequests(project.id);
      assert.equal(requests.length, 1);
      const [entry] = requests;
      assert.equal(entry.id, result.requestId);
      assert.equal(entry.state, 'PENDING');
      assert.equal(entry.request.purpose, 'LOCAL_REPLAN');
      assert.equal(entry.request.requestedBy, 'project-owner');
      assert.equal(entry.request.instruction, 'Amend the battle presentation tasks per the owner decision.');
      assert.equal(entry.request.guidance, LOCAL_REPLAN_GUIDANCE);
      assert.match(entry.request.guidance, /Never modify, remove, or re-run DONE work/);
      assert.equal(entry.context.sourceKind, 'project-owner-decision');
      // The entrance itself starts no work and creates no tasks.
      assert.equal(store.listTasks(project.id).length, 0);
    } finally { store.close(); }

    assert.throws(
      () => service.createOperatorReplan(project.id, { id: 'empty', instruction: '  ' }),
      /LOCAL_REPLAN_REQUIRES_INSTRUCTION/,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a LOCAL_REPLAN batch uses the single-pass planner flow and is claimed like any request', () => {
  const requests = [{
    id: 'P:local-replan:operator-test',
    sequence: 7,
    createdAt: new Date().toISOString(),
    request: { purpose: 'LOCAL_REPLAN', requestedBy: 'project-owner', instruction: 'x', guidance: 'g' },
    context: { sourceKind: 'project-owner-decision' },
  }];
  assert.equal(usesThreePassFlow(requests), false);
  const tasks = plannerFlowTasks('batch-7-7', requests);
  assert.equal(tasks[0].input.purpose, 'PLANNER_DECOMPOSE');
  assert.equal(tasks[0].stage, 'tech_lead');
  assert.ok(tasks.every(t => !String(t.input?.purpose ?? '').startsWith('PLANNER_FEATURES')));
  assert.ok(tasks.some(t => t.input?.purpose === 'PLANNER_PM_REVIEW'));

  const dir = mkdtempSync(join(tmpdir(), 'ariad-local-replan-batch-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', deliveryEnabled: true });
    store.enqueuePlanningRequest({
      id: 'P:local-replan:operator-test',
      projectId: 'P',
      request: { purpose: 'LOCAL_REPLAN', requestedBy: 'project-owner', instruction: 'x', guidance: 'g' },
      context: { sourceKind: 'project-owner-decision' },
    });
    const batch = createNextPlanningBatch({ store, projectId: 'P' });
    assert.ok(batch);
    const batchTasks = store.listTasks('P', { flowId: batch.flowId });
    assert.ok(batchTasks.length > 0);
    assert.equal(batchTasks.find(t => t.input?.purpose === 'PLANNER_DECOMPOSE')?.input?.requests?.[0]?.request?.purpose, 'LOCAL_REPLAN');
    const pending = store.listPlanningRequests('P', { states: ['PENDING'] });
    assert.equal(pending.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the decompose prompt carries a LOCAL REPLAN section with the owner requests', () => {
  const prompt = plannerPrompt({
    store: {},
    project: { id: 'P' },
    task: {
      input: {
        purpose: 'PLANNER_DECOMPOSE',
        requests: [{
          request: {
            purpose: 'LOCAL_REPLAN',
            requestedBy: 'project-owner',
            instruction: 'Amend the battle presentation tasks.',
            guidance: LOCAL_REPLAN_GUIDANCE,
          },
        }],
      },
    },
    artifactRoot: null,
  });
  assert.match(prompt, /LOCAL REPLAN \(PROJECT-OWNER DECISION\)/);
  assert.match(prompt, /Amend the battle presentation tasks\./);
});
