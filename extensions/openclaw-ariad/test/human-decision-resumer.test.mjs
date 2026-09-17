import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanDecisionResumer } from '../runtime/human-decision-resumer.js';
import { SQLiteWorkflowStateStore } from '../../../src/sqlite-workflow-state-store.js';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendEvent(path, event) {
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
}

function makeProject(root, id = 'p1') {
  const ariad = join(root, '.ariad');
  const projectDir = join(ariad, 'project');
  mkdirSync(projectDir, { recursive: true });
  const project = { id, root, workspace: join(root, 'workspace'), stateDb: join(ariad, 'state.db'), goal: 'ship the feature' };
  mkdirSync(project.workspace, { recursive: true });
  writeJson(join(projectDir, 'brief.json'), { version: 1, projectId: id, goal: project.goal, source: 'project-agent' });
  return { project, projectDir };
}

test('planning-level decision is journaled into the durable project brief for replanning', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-human-plan-'));
  try {
    const { project, projectDir } = makeProject(root, 'plan');
    appendEvent(join(projectDir, 'project-agent-events.jsonl'), {
      version: 1,
      id: 'plan:e1',
      projectId: 'plan',
      type: 'NEEDS_HUMAN',
      createdAt: '2026-09-17T18:00:00.000Z',
      payload: { sourceRole: 'pm', phase: 'PLAN_REVIEW', questions: ['Keep compatibility?'] },
      delivery: 'PENDING',
    });

    const result = new HumanDecisionResumer({ project, now: () => new Date('2026-09-17T18:01:00.000Z') })
      .submit('Keep the public API backward compatible.');

    assert.equal(result.resumedTaskId, null);
    assert.equal(result.record.eventId, 'plan:e1');
    const brief = JSON.parse(readFileSync(join(projectDir, 'brief.json'), 'utf8'));
    assert.equal(brief.decisions.at(-1).decision, 'Keep the public API backward compatible.');
    const journal = readFileSync(join(projectDir, 'human-decisions.jsonl'), 'utf8');
    assert.match(journal, /plan:e1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task-level decision resumes exactly the durable stage that requested human input', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-human-task-'));
  try {
    const { project, projectDir } = makeProject(root, 'task');
    writeJson(join(root, '.ariad', 'task-graph.json'), { version: 2, tasks: [{ id: 'T1', dependsOn: [] }] });
    const store = new SQLiteWorkflowStateStore(project.stateDb);
    store.create('T1', {
      stage: 'project_debugger',
      devCycle: 3,
      strategyEpoch: 2,
      status: 'NEEDS_HUMAN',
      context: { reason: 'requirements conflict' },
    });
    store.close();
    appendEvent(join(projectDir, 'project-agent-events.jsonl'), {
      version: 1,
      id: 'task:e1',
      projectId: 'task',
      type: 'NEEDS_HUMAN',
      createdAt: '2026-09-17T18:00:00.000Z',
      payload: { sourceRole: 'project_debugger', phase: 'TASK_WORKFLOW', taskId: 'T1' },
      delivery: 'PENDING',
    });

    const result = new HumanDecisionResumer({ project }).submit('Preserve compatibility; the new behavior is optional.');
    assert.equal(result.resumedTaskId, 'T1');

    const reopened = new SQLiteWorkflowStateStore(project.stateDb);
    const state = reopened.get('T1');
    reopened.close();
    assert.equal(state.status, 'RUNNING');
    assert.equal(state.stage, 'project_debugger');
    assert.equal(state.devCycle, 3);
    assert.equal(state.strategyEpoch, 2);
    assert.equal(state.context.humanDecision.decision, 'Preserve compatibility; the new behavior is optional.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a NEEDS_HUMAN request can be answered only once', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-human-once-'));
  try {
    const { project, projectDir } = makeProject(root, 'once');
    appendEvent(join(projectDir, 'project-agent-events.jsonl'), {
      version: 1,
      id: 'once:e1',
      projectId: 'once',
      type: 'NEEDS_HUMAN',
      createdAt: '2026-09-17T18:00:00.000Z',
      payload: { phase: 'PLAN_REVIEW' },
      delivery: 'PENDING',
    });
    const resumer = new HumanDecisionResumer({ project });
    resumer.submit('Use option A.');
    assert.throws(() => resumer.submit('Use option B.'), /not waiting for a human decision/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
