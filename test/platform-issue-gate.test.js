import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { TASK_KINDS } from '../src/v2/control-task-policy.js';
import { applyTaskEvent } from '../src/v2/state-machine.js';
import { escalatePlatformIssue, recordPlatformGateDecision } from '../src/v2/platform-issue-gate.js';

// Platform-defect escalation (owner decision, 2026-11-27): a defect in
// Ariad itself bypasses Tech Lead triage and raises a human gate
// immediately - a HUMAN_GATE task born in NEEDS_HUMAN. The ordinary
// decision path closes the gate and records the decision on the issue.

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-platform-gate-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  store.createProject({ id: 'P' });
  return { dir, store };
}

function platformIssue(store, fingerprint = 'plat-1') {
  return store.createIssue({
    projectId: 'P',
    source: { kind: 'internal-role', ref: 't-1:tester' },
    sourceTaskId: 't-1',
    reportedBy: 'tester',
    title: 'spec export drops criteria',
    description: 'canonical artifact serializes acceptanceCriteria as empty',
    fingerprint,
    target: 'platform',
  });
}

test('createIssue records the report target, defaulting to project', () => {
  const { dir, store } = makeStore();
  try {
    const plat = platformIssue(store);
    assert.equal(plat.target, 'platform');
    const proj = store.createIssue({ projectId: 'P', title: 'broken button', description: 'ui defect', fingerprint: 'proj-1' });
    assert.equal(proj.target, 'project');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('escalation raises a HUMAN_GATE task born in NEEDS_HUMAN and parks the issue on it', () => {
  const { dir, store } = makeStore();
  try {
    const issue = platformIssue(store);
    const { issue: updated, gate, created } = escalatePlatformIssue(store, issue);
    assert.equal(created, true);
    assert.equal(updated.state, 'NEEDS_HUMAN');
    assert.equal(updated.gateTaskId, gate.id);
    assert.equal(gate.taskKind, TASK_KINDS.HUMAN_GATE);
    assert.equal(gate.state, 'NEEDS_HUMAN');
    assert.equal(gate.stage, 'human');
    assert.equal(gate.input.issueId, issue.id);
    // Idempotent while the gate is open: no second gate task.
    const again = escalatePlatformIssue(store, store.getIssue(issue.id));
    assert.equal(again.created, false);
    assert.equal(again.gate.id, gate.id);
    assert.equal(store.listAllTasks('P').filter(t => t.taskKind === TASK_KINDS.HUMAN_GATE).length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('escalation refuses a project-target issue', () => {
  const { dir, store } = makeStore();
  try {
    const proj = store.createIssue({ projectId: 'P', title: 'broken button', description: 'ui defect', fingerprint: 'proj-1' });
    assert.throws(() => escalatePlatformIssue(store, proj), /PLATFORM_GATE_REQUIRES_PLATFORM_ISSUE/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HUMAN_GATE policy: human stage and human-gate flow are required', () => {
  const { dir, store } = makeStore();
  try {
    assert.throws(() => store.createTask({
      id: 'g-bad-stage', projectId: 'P', taskKind: TASK_KINDS.HUMAN_GATE,
      flowId: 'human-gate:x', stage: 'developer', state: 'NEEDS_HUMAN', title: 'x',
    }), /HUMAN_GATE_REQUIRES_HUMAN_STAGE/);
    assert.throws(() => store.createTask({
      id: 'g-bad-flow', projectId: 'P', taskKind: TASK_KINDS.HUMAN_GATE,
      flowId: 'planner:batch-1', stage: 'human', state: 'NEEDS_HUMAN', title: 'x',
    }), /HUMAN_GATE_REQUIRES_GATE_FLOW/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a human decision closes a gate task but returns ordinary gates to READY', () => {
  const gateTask = { state: 'NEEDS_HUMAN', taskKind: TASK_KINDS.HUMAN_GATE };
  assert.equal(applyTaskEvent(gateTask, 'HUMAN_DECISION', {}, { humanGate: true }).state, 'DONE');
  const pmTask = { state: 'NEEDS_HUMAN', taskKind: TASK_KINDS.PLANNING };
  assert.equal(applyTaskEvent(pmTask, 'HUMAN_DECISION', {}, { humanGate: false }).state, 'READY');
  assert.equal(applyTaskEvent(pmTask, 'HUMAN_DECISION', {}, {}).state, 'READY');
});

test('the decision is recorded on the issue, which leaves the project queue', () => {
  const { dir, store } = makeStore();
  try {
    const issue = platformIssue(store);
    const { gate } = escalatePlatformIssue(store, issue);
    const decided = recordPlatformGateDecision(store, gate, 'platform team will fix the serializer');
    assert.equal(decided.state, 'HUMAN_DECIDED');
    assert.equal(decided.humanDecision.decision, 'platform team will fix the serializer');
    assert.equal(decided.humanDecision.gateTaskId, gate.id);
    // A re-report after the decision raises a fresh gate instead of
    // resurrecting the closed one.
    const again = escalatePlatformIssue(store, store.getIssue(issue.id));
    assert.equal(again.created, true);
    assert.notEqual(again.gate.id, gate.id);
    assert.equal(again.gate.state, 'NEEDS_HUMAN');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the scheduler never dispatches a pending human gate', async () => {
  const { dir, store } = makeStore();
  try {
    const issue = platformIssue(store);
    const { gate } = escalatePlatformIssue(store, issue);
    store.createTask({ projectId: 'P', stage: 'developer', id: 't-delivery', taskKind: 'FEATURE_TASK', featureId: 'f1', dependsOn: [] });
    const roles = new RoleRegistry();
    for (const stage of ['developer', 'tech_lead', 'pm']) {
      roles.register(stage, { prepare: () => ({ provider: 'fake' }), transition: () => ({ state: 'DONE' }) });
    }
    const providers = new ProviderRegistry();
    providers.register({ id: 'fake', start: async () => ({ externalId: 'ex' }), poll: async () => ({ state: 'RUNNING' }), cancel: async () => {} });
    const scheduler = new V2Scheduler({ store, roles, providers, resources: new ResourcePool({}) });
    const result = await scheduler.tick('P', {});
    assert.ok(!result.started.includes(gate.id), 'gate task must never dispatch');
    assert.equal(store.getTask(gate.id).state, 'NEEDS_HUMAN');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
