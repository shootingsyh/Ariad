import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AriadProjectController } from '../runtime/project-controller.js';

function projectModel({ existingProject = false } = {}) {
  return {
    currentState: {
      existingProject,
      summary: existingProject ? 'Existing small Node project with a README.' : 'Greenfield project.',
      keyFiles: existingProject ? ['README.md'] : [],
      knownConstraints: [],
    },
    architecture: {
      horizontals: [{ id: 'runtime', name: 'Runtime', responsibility: 'Shared runtime and app shell' }],
      verticals: [{ id: 'health-feature', name: 'Health feature', responsibility: 'Expose deterministic health state' }],
    },
    contracts: [{
      id: 'health-contract',
      provider: 'health-feature',
      consumers: ['runtime'],
      purpose: 'Expose health state',
      interface: 'health.txt contains status and cycle',
      testBoundary: 'Read health.txt and verify status',
      maturity: 'PROVISIONAL',
      justifiedByVerticals: ['health-slice'],
    }],
    dependencies: [{
      from: 'runtime',
      to: 'health-feature',
      contractId: 'health-contract',
      implementationRequired: false,
      rationale: 'Runtime consumes the health boundary; the walking skeleton can use the minimal implementation.',
    }],
    verticalSlices: [{
      id: 'health-slice',
      name: 'Health walking skeleton',
      goal: 'Deliver the smallest user-visible health path end to end.',
      componentIds: ['runtime', 'health-feature'],
      contractIds: ['health-contract'],
      skeletonTest: 'Read the final health.txt through the same boundary used by the feature.',
      taskIds: ['T1'],
    }],
    technicalDirection: {
      summary: 'Use the existing Node runtime and file-based deterministic fixture.',
      foundations: ['Node.js'],
      languages: [{ scope: 'application', language: 'JavaScript', rationale: 'Matches the existing project' }],
      decisions: [{ decision: 'Keep a single-process test fixture', rationale: 'Minimize complexity' }],
    },
    decomposition: {
      nodes: [
        { id: 'runtime-node', parentId: null, kind: 'component', componentId: 'runtime', children: [], taskId: null },
        { id: 'health-feature-node', parentId: null, kind: 'component', componentId: 'health-feature', children: ['T1-node'], taskId: null },
        { id: 'T1-node', parentId: 'health-feature-node', kind: 'task', componentId: 'health-feature', children: [], taskId: 'T1' },
      ],
    },
    tasks: [{
      id: 'T1',
      title: 'Implement deterministic health state',
      componentId: 'health-feature',
      verticalSliceId: 'health-slice',
      acceptanceCriteria: ['passes after one review retry'],
      testStrategy: 'Read health.txt and verify the final healthy state',
      atomic: true,
      dependsOn: [],
    }],
  };
}

class ScriptedRuntimeAdapter {
  id = 'scripted-project';
  runs = new Map();
  sequence = 0;

  async install() { return { installed: true }; }
  async probe() { return { health: 'HEALTHY' }; }
  async start(input) {
    const externalId = `script-${++this.sequence}`;
    this.runs.set(externalId, input);
    return { runtimeId: this.id, runId: input.runId, externalId, state: 'RUNNING' };
  }
  async resume(input) { return this.start(input); }
  async cancel() { return { state: 'CANCELLED' }; }
  async poll(handle) {
    const input = this.runs.get(handle.externalId);
    const cycle = input.context?.devCycle ?? 0;
    if (input.role === 'tech_lead') {
      return { state: 'COMPLETED', outcome: 'PLANNED', result: { projectModel: projectModel({ existingProject: input.context?.planningPhase === 'EXISTING_PROJECT_DISCOVERY' }) } };
    }
    if (input.role === 'pm') {
      const outcome = input.context?.productPhase === 'CURRENT_STATE_REVIEW' ? 'CURRENT_STATE_ACKNOWLEDGED' : 'PLAN_ACCEPTED';
      return { state: 'COMPLETED', outcome, result: { reason: 'covers the requested customer outcome', guidance: '', customerOutcomeSummary: 'Ready to implement', questions: [] } };
    }
    if (input.role === 'developer') return { state: 'COMPLETED', outcome: 'IMPLEMENTATION_READY', result: { cycle } };
    if (input.role === 'tester') return { state: 'COMPLETED', outcome: 'PASS', result: { cycle } };
    if (input.role === 'reviewer' && cycle === 1) return { state: 'COMPLETED', outcome: 'NOT_PASS', result: { cycle } };
    if (input.role === 'reviewer') return { state: 'COMPLETED', outcome: 'PASS', result: { cycle } };
    throw new Error(`unexpected role ${input.role}`);
  }
}

function recordingProjectAgentAdapter(notifications) {
  return {
    id: 'recording-project-agent',
    async bindProject(binding) { return binding; },
    async notify(input) { notifications.push(structuredClone(input)); return { ok: true }; },
    async submitDecision(input) { return input; },
  };
}

async function waitForController(controller) {
  await controller.start();
  while (controller.status().active) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('AriadProjectController persists TL living architecture, obtains PM approval, then converges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-project-controller-'));
  try {
    const ariad = join(root, '.ariad');
    const workspace = join(root, 'workspace');
    mkdirSync(ariad, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const stateDb = join(ariad, 'state.db');
    const controller = new AriadProjectController({ project: { id: 'p1', root, workspace, stateDb, goal: 'build a tiny feature' }, runtimeAdapter: new ScriptedRuntimeAdapter() });

    await waitForController(controller);
    assert.equal(controller.status().phase, 'SUCCEEDED', JSON.stringify(controller.status()));

    const modelDir = join(ariad, 'project');
    for (const name of ['brief.json', 'current-state.json', 'architecture.json', 'contracts.json', 'dependencies.json', 'vertical-slices.json', 'technical-direction.json', 'decomposition.json', 'project-model.json', 'plan-review.json', 'task-graph.json']) {
      assert.equal(existsSync(join(modelDir, name)), true, `${name} must be durable`);
    }
    assert.equal(JSON.parse(readFileSync(join(modelDir, 'plan-review.json'), 'utf8')).outcome, 'PLAN_ACCEPTED');
    assert.equal(JSON.parse(readFileSync(join(modelDir, 'contracts.json'), 'utf8'))[0].maturity, 'PROVISIONAL');
    assert.equal(JSON.parse(readFileSync(join(modelDir, 'vertical-slices.json'), 'utf8'))[0].skeletonTest.length > 0, true);

    const db = new DatabaseSync(stateDb, { readOnly: true });
    const state = db.prepare('SELECT dev_cycle, status, context_json FROM workflow_state WHERE task_id = ?').get('T1');
    const runs = db.prepare('SELECT role, attempt, state FROM runs ORDER BY seq').all();
    db.close();
    assert.equal(state.status, 'SUCCEEDED');
    assert.equal(state.dev_cycle, 2);
    const context = JSON.parse(state.context_json);
    assert.equal(context.task.verticalSliceId, 'health-slice');
    assert.equal(context.dependencies[0].contractId, 'health-contract');
    assert.equal(context.verticalSlices[0].id, 'health-slice');
    assert.deepEqual(runs.map((run) => run.role), ['tech_lead', 'pm', 'developer', 'tester', 'reviewer', 'developer', 'tester', 'reviewer']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing workspace current state is journaled and delivered to the bound Project Agent before planning continues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-existing-project-'));
  try {
    const ariad = join(root, '.ariad');
    const workspace = join(root, 'workspace');
    mkdirSync(ariad, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'README.md'), '# Existing app\n');
    const stateDb = join(ariad, 'state.db');
    const adapter = new ScriptedRuntimeAdapter();
    const notifications = [];
    const controller = new AriadProjectController({
      project: {
        id: 'existing', root, workspace, stateDb, goal: 'add a health feature',
        projectAgent: { host: 'test', agentId: 'project-agent', sessionKey: 'project-session' },
      },
      runtimeAdapter: adapter,
      projectAgentAdapter: recordingProjectAgentAdapter(notifications),
    });

    await waitForController(controller);
    assert.equal(controller.status().phase, 'SUCCEEDED', JSON.stringify(controller.status()));

    const calls = [...adapter.runs.values()].map((run) => ({ role: run.role, context: run.context }));
    assert.deepEqual(calls.slice(0, 4).map((call) => call.role), ['tech_lead', 'pm', 'tech_lead', 'pm']);
    assert.equal(calls[0].context.planningPhase, 'EXISTING_PROJECT_DISCOVERY');
    assert.equal(calls[1].context.productPhase, 'CURRENT_STATE_REVIEW');
    assert.equal(calls[2].context.planningPhase, 'REQUIREMENT_PLAN');
    assert.equal(calls[3].context.productPhase, 'PLAN_REVIEW');
    assert.equal(calls[1].context.currentProjectModel.currentState.existingProject, true);
    const currentReview = JSON.parse(readFileSync(join(ariad, 'project', 'current-state-review.json'), 'utf8'));
    assert.equal(currentReview.outcome, 'CURRENT_STATE_ACKNOWLEDGED');

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].event.type, 'CURRENT_STATE_READY');
    assert.equal(notifications[0].binding.sessionKey, 'project-session');
    assert.equal(notifications[0].event.payload.currentState.existingProject, true);
    const journal = readFileSync(join(ariad, 'project', 'project-agent-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal[0].type, 'CURRENT_STATE_READY');
    assert.equal(journal[0].delivery, 'PENDING');
    assert.equal(journal[1].eventId, journal[0].id);
    assert.equal(journal[1].delivery, 'DELIVERED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PM NEEDS_HUMAN is routed to Project Agent and blocks Developer execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-needs-human-'));
  try {
    const ariad = join(root, '.ariad');
    const workspace = join(root, 'workspace');
    mkdirSync(ariad, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const adapter = new ScriptedRuntimeAdapter();
    const originalPoll = adapter.poll.bind(adapter);
    adapter.poll = async (handle) => {
      const input = adapter.runs.get(handle.externalId);
      if (input.role === 'pm' && input.context?.productPhase === 'PLAN_REVIEW') {
        return {
          state: 'COMPLETED',
          outcome: 'NEEDS_HUMAN',
          result: { reason: 'Product choice required', guidance: '', customerOutcomeSummary: '', questions: ['Should the health state be public?'] },
        };
      }
      return originalPoll(handle);
    };
    const notifications = [];
    const controller = new AriadProjectController({
      project: {
        id: 'human', root, workspace, stateDb: join(ariad, 'state.db'), goal: 'build',
        projectAgent: { host: 'test', agentId: 'project-agent', sessionKey: 'project-session' },
      },
      runtimeAdapter: adapter,
      projectAgentAdapter: recordingProjectAgentAdapter(notifications),
    });

    await waitForController(controller);
    assert.equal(controller.status().phase, 'NEEDS_HUMAN');
    assert.equal([...adapter.runs.values()].some((run) => run.role === 'developer'), false);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].event.type, 'NEEDS_HUMAN');
    assert.equal(notifications[0].event.payload.sourceRole, 'pm');
    assert.equal(notifications[0].event.payload.phase, 'PLAN_REVIEW');
    assert.deepEqual(notifications[0].event.payload.questions, ['Should the health state be public?']);
    const journal = readFileSync(join(ariad, 'project', 'project-agent-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal[0].type, 'NEEDS_HUMAN');
    assert.equal(journal[1].delivery, 'DELIVERED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Tech Lead project model rejects a task that is not an atomic decomposition leaf', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-quality-gate-'));
  try {
    const ariad = join(root, '.ariad');
    const workspace = join(root, 'workspace');
    mkdirSync(ariad, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const adapter = new ScriptedRuntimeAdapter();
    const originalPoll = adapter.poll.bind(adapter);
    adapter.poll = async (handle) => {
      const input = adapter.runs.get(handle.externalId);
      if (input.role === 'tech_lead') {
        const model = projectModel();
        const taskNode = model.decomposition.nodes.find((node) => node.id === 'T1-node');
        taskNode.children = ['nested-child'];
        model.decomposition.nodes.push({
          id: 'nested-child',
          parentId: 'T1-node',
          kind: 'subcomponent',
          componentId: 'health-feature',
          children: [],
          taskId: null,
        });
        return { state: 'COMPLETED', outcome: 'PLANNED', result: { projectModel: model } };
      }
      return originalPoll(handle);
    };
    const controller = new AriadProjectController({ project: { id: 'bad', root, workspace, stateDb: join(ariad, 'state.db'), goal: 'build' }, runtimeAdapter: adapter });
    await waitForController(controller);
    assert.equal(controller.status().phase, 'FAILED');
    assert.match(controller.status().error, /must be a leaf in decomposition/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Tech Lead project model rejects speculative contracts not justified by a vertical slice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-contract-pressure-'));
  try {
    const ariad = join(root, '.ariad');
    const workspace = join(root, 'workspace');
    mkdirSync(ariad, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const adapter = new ScriptedRuntimeAdapter();
    const originalPoll = adapter.poll.bind(adapter);
    adapter.poll = async (handle) => {
      const input = adapter.runs.get(handle.externalId);
      if (input.role === 'tech_lead') {
        const model = projectModel();
        model.contracts[0].justifiedByVerticals = ['future-maybe-slice'];
        return { state: 'COMPLETED', outcome: 'PLANNED', result: { projectModel: model } };
      }
      return originalPoll(handle);
    };
    const controller = new AriadProjectController({ project: { id: 'speculative', root, workspace, stateDb: join(ariad, 'state.db'), goal: 'build' }, runtimeAdapter: adapter });
    await waitForController(controller);
    assert.equal(controller.status().phase, 'FAILED');
    assert.match(controller.status().error, /justified by unknown vertical slice/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
