import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { AriadService } from '../src/runtime/ariad-service.js';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { ARIAD_MODEL_ROLES } from '../src/runtime/role-models.js';
import { LOCAL_REPLAN_GUIDANCE } from '../src/runtime/standalone-project-runtime.js';
import { plannerFlowTasks, createNextPlanningBatch, usesThreePassFlow } from '../src/v2/planner-flow.js';
import { plannerPrompt } from '../src/v2/role-prompts.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { recordRequirementsApproval } from '../src/v2/project-docs.js';

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
  // PM settles the requirements side FIRST; decomposition depends on it.
  assert.equal(tasks[0].input.purpose, 'LOCAL_REPLAN_REQUIREMENTS');
  assert.equal(tasks[0].stage, 'pm');
  const decompose = tasks.find(t => t.input?.purpose === 'PLANNER_DECOMPOSE');
  assert.ok(decompose);
  assert.deepEqual(decompose.dependsOn, [tasks[0].id]);
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
    const gate = batchTasks.find(t => t.input?.purpose === 'LOCAL_REPLAN_REQUIREMENTS');
    assert.ok(gate);
    assert.equal(gate.stage, 'pm');
    assert.deepEqual(
      batchTasks.find(t => t.input?.purpose === 'PLANNER_DECOMPOSE')?.dependsOn,
      [gate.id],
    );
    const pending = store.listPlanningRequests('P', { states: ['PENDING'] });
    assert.equal(pending.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a batch without a LOCAL_REPLAN request has no PM requirements gate', () => {
  const tasks = plannerFlowTasks('batch-8-8', [{
    id: 'P:issue:x',
    sequence: 8,
    createdAt: new Date().toISOString(),
    request: { purpose: 'TRIAGE_AND_ASSIGN_ISSUE', issueId: 'i1', instruction: 'triage' },
    context: { sourceKind: 'internal' },
  }]);
  assert.ok(tasks.every(t => t.input?.purpose !== 'LOCAL_REPLAN_REQUIREMENTS'));
  const decompose = tasks.find(t => t.input?.purpose === 'PLANNER_DECOMPOSE');
  assert.ok(decompose);
  assert.equal(decompose.dependsOn, undefined);
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

// PM-first gate (owner ruling, 2026-11-02): a requirements-touching local
// replan is a PM bug if the PM lets planning proceed on stale text - the
// PM revises REQUIREMENTS.md and obtains the owner's approval FIRST, and
// only then does decomposition (the replan proper) start.

function pmGateTransition(result, { approved = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-lr-pmgate-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: false, workspace: dir });
    if (approved) {
      mkdirSync(join(dir, '.ariad', 'docs'), { recursive: true });
      writeFileSync(join(dir, '.ariad', 'docs', 'REQUIREMENTS.md'), '# Requirements\n');
      recordRequirementsApproval(dir, { approvedBy: 'test-owner' });
    }
    const roles = createDefaultV2Roles({
      store, workspace: dir, artifactRoot: join(dir, '.ariad', 'artifacts'),
      providerId: 'fake', codeProviderId: 'ariad-code',
    });
    const task = {
      id: 'planner:batch-1-1:requirements-delta', projectId: 'P', taskKind: 'PLANNING',
      stage: 'pm', flowId: 'planner:P:batch-1-1',
      input: { purpose: 'LOCAL_REPLAN_REQUIREMENTS', requests: [] }, history: [],
    };
    return { transition: roles.pm.transition({ task, result }), roles, task, dir };
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('PM gate: no wording change mandated closes the gate at once', () => {
  const { transition } = pmGateTransition({ outcome: 'PLAN_ACCEPTED', result: { noRequirementsChange: true } });
  assert.equal(transition.state, 'DONE');
  assert.equal(transition.transitionHistory.type, 'LOCAL_REPLAN_REQUIREMENTS_CLEARED');
});

test('PM gate: an edited document parks for the owner approval, with the PM questions', () => {
  const { transition } = pmGateTransition({
    outcome: 'NEEDS_HUMAN',
    summary: 'Section 5 revised per the owner decision.',
    result: { questions: ['Review the edited REQUIREMENTS.md and approve it (ariad project approve-requirements P)?'] },
  });
  assert.equal(transition.state, 'NEEDS_HUMAN');
  assert.equal(transition.transitionHistory.type, 'PM_HUMAN_DECISION');
  assert.deepEqual(transition.transitionHistory.questions, ['Review the edited REQUIREMENTS.md and approve it (ariad project approve-requirements P)?']);
});

test('PM gate: PLAN_ACCEPTED over an unapproved document still parks', () => {
  const { transition } = pmGateTransition({ outcome: 'PLAN_ACCEPTED', result: {} });
  assert.equal(transition.state, 'NEEDS_HUMAN');
  assert.equal(transition.transitionHistory.type, 'PM_HUMAN_DECISION');
  assert.match(transition.transitionHistory.questions[0], /approve-requirements/);
});

test('PM gate: once the document stands approved, the gate closes', () => {
  const { transition } = pmGateTransition({ outcome: 'PLAN_ACCEPTED', result: {} }, { approved: true });
  assert.equal(transition.state, 'DONE');
  assert.equal(transition.transitionHistory.type, 'LOCAL_REPLAN_REQUIREMENTS_CLEARED');
});

test('PM gate prompt scopes the PM to the requirements document only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-lr-pmprompt-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: false, workspace: dir });
    const roles = createDefaultV2Roles({
      store, workspace: dir, artifactRoot: join(dir, '.ariad', 'artifacts'),
      providerId: 'fake', codeProviderId: 'ariad-code',
    });
    const prepared = roles.pm.prepare({
      project: { id: 'P', mode: 'NEW', workspace: dir },
      task: {
        id: 'planner:batch-1-1:requirements-delta', projectId: 'P', taskKind: 'PLANNING',
        stage: 'pm', flowId: 'planner:P:batch-1-1',
        input: { purpose: 'LOCAL_REPLAN_REQUIREMENTS', requests: [] }, history: [],
      },
    });
    assert.match(JSON.stringify(prepared), /requirements side of a LOCAL REPLAN/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
