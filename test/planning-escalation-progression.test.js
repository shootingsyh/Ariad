import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { executorTransitionFromResult } from '../src/v2/role-executor-transition.js';
import { RoleResultDispatcher } from '../src/v2/role-result-dispatcher.js';

// Escalation whitelist, executor layer: planning-stage failures retry at
// the tech lead, then route to the project debugger, and only a terminal
// debugger diagnosis may surface - as SYSTEM_BLOCKED (system dead), never
// as a per-task human decision.

test('executor terminal mapping: planning machines block, delivery still parks for diagnosis', () => {
  const planDebugger = { taskKind: 'PLANNING', stage: 'project_debugger' };
  assert.equal(executorTransitionFromResult(planDebugger, 'NEEDS_HUMAN').patch.state, 'SYSTEM_BLOCKED');
  const subPlanDebugger = { taskKind: 'NODE_PLANNING', stage: 'project_debugger', input: {} };
  assert.equal(executorTransitionFromResult(subPlanDebugger, 'NEEDS_HUMAN').patch.state, 'SYSTEM_BLOCKED');
  const deliveryDebugger = { taskKind: 'FEATURE_TASK', stage: 'project_debugger' };
  assert.equal(executorTransitionFromResult(deliveryDebugger, 'NEEDS_HUMAN').patch.state, 'NEEDS_HUMAN');
  const pmTask = { taskKind: 'PLANNING', stage: 'pm' };
  assert.equal(executorTransitionFromResult(pmTask, 'HUMAN_GATE').patch.state, 'NEEDS_HUMAN');
});

test('planning gate failures retry at the tech lead twice, then route to the debugger', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const base = { id: 'v', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', history: [] };
  const fail = { outcome: 'FAIL', result: { error: 'bad plan' } };
  const first = roles.plan_validator.transition({ task: { ...base, input: { purpose: 'PLANNING_ROUTE_VALIDATE', planGateRetries: 0 } }, result: fail });
  assert.equal(first.state, 'READY');
  assert.equal(first.stage, 'tech_lead');
  assert.equal(first.transitionHistory.type, 'PLAN_GATE_RETRY');
  assert.equal(first.input.planGateRetries, 1);
  const exhausted = roles.plan_validator.transition({ task: { ...base, input: { purpose: 'PLANNING_ROUTE_VALIDATE', planGateRetries: 2 } }, result: fail });
  assert.equal(exhausted.state, 'READY');
  assert.equal(exhausted.stage, 'project_debugger');
  assert.equal(exhausted.transitionHistory.type, 'PLAN_DEBUGGER_ROUTED');
});

test('planning debugger: one guided recovery, then a terminal SYSTEM_BLOCKED diagnosis', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const task = { id: 'd', projectId: 'P', taskKind: 'PLANNING', stage: 'project_debugger', input: {}, history: [] };
  const repaired = roles.project_debugger.transition({ task, result: { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Split the interface stage.' } } });
  assert.equal(repaired.state, 'READY');
  assert.equal(repaired.stage, 'tech_lead');
  assert.equal(repaired.transitionHistory.type, 'PLAN_DEBUGGER_RECOVERY');
  const diagnosed = roles.project_debugger.transition({ task, result: { outcome: 'UNKNOWN_PROJECT_CAUSE', summary: 'No viable repair.' } });
  assert.equal(diagnosed.state, 'SYSTEM_BLOCKED');
  assert.equal(diagnosed.transitionHistory.type, 'PLAN_DEBUGGER_DIAGNOSIS');
  const secondRecovery = roles.project_debugger.transition({
    task: { ...task, input: { planDebuggerRecoveryCount: 1 } },
    result: { outcome: 'RETRY_WITH_GUIDANCE', result: { guidance: 'Try again.' } },
  });
  assert.equal(secondRecovery.state, 'SYSTEM_BLOCKED');
});

test('dispatcher persists a planning debugger diagnosis as SYSTEM_BLOCKED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-plan-block-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', mode: 'NEW', deliveryEnabled: false, spec: 'x' });
    store.enqueuePlanningRequest({ id: 'r1', projectId: 'P', request: { purpose: 'INITIAL_PLAN' } });
    store.createPlanningBatch({
      projectId: 'P', batchId: 'b1', requestIds: ['r1'],
      tasks: [{ id: 'DBG', stage: 'tech_lead', state: 'DONE', input: {} }],
    });
    // Runtime stage changes bypass creation-time validation (a debugger
    // stage belongs to DIAGNOSTIC tasks at creation); move the task the
    // way a transition patch would, with its debugger result attached.
    const seeded = store.getTask('DBG');
    store.appendTaskHistory('DBG', seeded.version,
      { type: 'ROLE_RESULT', role: 'project_debugger', outcome: 'UNKNOWN_PROJECT_CAUSE', summary: 'No viable repair.' },
      { stage: 'project_debugger', state: 'RESULT_READY', input: {} });
    const definitions = createDefaultV2Roles({ store, workspace: dir, artifactRoot: join(dir, '.ariad', 'artifacts'), providerId: 'fake', codeProviderId: 'ariad-code' });
    const roles = { get: name => definitions[name] };
    await new RoleResultDispatcher({ store, roles }).advanceResults('P');
    assert.equal(store.getTask('DBG').state, 'SYSTEM_BLOCKED');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
