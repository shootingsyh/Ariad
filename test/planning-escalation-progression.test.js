import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { executorTransitionFromResult } from '../src/v2/role-executor-transition.js';
import { RoleResultDispatcher } from '../src/v2/role-result-dispatcher.js';
import { ensureInterfaceArtifactLayout } from '../src/v2/interface-contracts.js';

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

test('a planning result is bounced when the session left invalid planner artifacts on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-artifact-guard-'));
  try {
    const artifactRoot = join(dir, '.ariad', 'artifacts');
    const expand = { kind: 'expand', reason: 'r' };
    const leaf = { kind: 'leaf', reason: 'r' };
    const skeleton = { version: 1, nodeType: 'feature', interfaces: [], imports: [], integrationScenarios: [] };
    const entry = { id: 't1', title: 'T', intent: 'i', acceptanceCriteria: ['a'], testStrategy: 's', verification: [], interfaceIds: [], issueRefs: [] };
    mkdirSync(join(artifactRoot, 'planner', 'logical'), { recursive: true });
    mkdirSync(join(artifactRoot, 'planner', 'interfaces', 'features'), { recursive: true });
    writeFileSync(join(artifactRoot, 'planner', 'logical', 'x.json'), JSON.stringify({ ...skeleton, id: 'x', nodeId: 'x', parentId: null, decomposition: expand }));
    writeFileSync(join(artifactRoot, 'planner', 'logical', 'x.y.json'), JSON.stringify({ ...skeleton, id: 'x.y', nodeId: 'x.y', parentId: 'x', decomposition: leaf }));
    writeFileSync(join(artifactRoot, 'planner', 'interfaces', 'features', 'x.json'), JSON.stringify({ ...skeleton, nodeId: 'x', decomposition: expand }));
    const contractPath = join(artifactRoot, 'planner', 'interfaces', 'features', 'x.y.json');
    writeFileSync(contractPath, JSON.stringify({ ...skeleton, nodeId: 'x.y', decomposition: leaf, featureTasks: [entry] }));
    const roles = createDefaultV2Roles({ store: {}, workspace: dir, artifactRoot });
    const task = { id: 'g', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', input: { purpose: 'PLANNING_ROUTE' }, history: [] };
    const routed = { outcome: 'PLANNING_ROUTE', result: { stages: {} } };
    const accepted = roles.tech_lead.transition({ task, result: routed });
    assert.equal(accepted.state, 'DONE');
    // The writer now leaves a key the strict loader rejects (the
    // 2026-10-29 incident shape); acceptance must bounce it back to the
    // tech lead through the gate ladder instead of sealing it.
    writeFileSync(contractPath, JSON.stringify({ ...skeleton, nodeId: 'x.y', decomposition: leaf, featureTasks: [{ ...entry, history: [] }] }));
    const bounced = roles.tech_lead.transition({ task, result: routed });
    assert.equal(bounced.state, 'READY');
    assert.equal(bounced.stage, 'tech_lead');
    assert.equal(bounced.transitionHistory.type, 'PLAN_GATE_RETRY');
    assert.equal(bounced.input.previousGateFailure.blockedType, 'ARTIFACT_VALIDATION_FAILED');
    assert.match(bounced.input.previousGateFailure.summary, /history: unexpected property/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gate bounce names the unparseable artifact in history and routed summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-artifact-guard-json-'));
  try {
    const artifactRoot = join(dir, '.ariad', 'artifacts');
    const expand = { kind: 'expand', reason: 'r' };
    const leaf = { kind: 'leaf', reason: 'r' };
    const skeleton = { version: 1, nodeType: 'feature', interfaces: [], imports: [], integrationScenarios: [] };
    const entry = { id: 't1', title: 'T', intent: 'i', acceptanceCriteria: ['a'], testStrategy: 's', verification: [], interfaceIds: [], issueRefs: [] };
    mkdirSync(join(artifactRoot, 'planner', 'logical'), { recursive: true });
    mkdirSync(join(artifactRoot, 'planner', 'interfaces', 'features'), { recursive: true });
    mkdirSync(join(artifactRoot, 'planner', 'milestones'), { recursive: true });
    writeFileSync(join(artifactRoot, 'planner', 'logical', 'x.json'), JSON.stringify({ ...skeleton, id: 'x', nodeId: 'x', parentId: null, decomposition: expand }));
    writeFileSync(join(artifactRoot, 'planner', 'logical', 'x.y.json'), JSON.stringify({ ...skeleton, id: 'x.y', nodeId: 'x.y', parentId: 'x', decomposition: leaf }));
    writeFileSync(join(artifactRoot, 'planner', 'interfaces', 'features', 'x.json'), JSON.stringify({ ...skeleton, nodeId: 'x', decomposition: expand }));
    writeFileSync(join(artifactRoot, 'planner', 'interfaces', 'features', 'x.y.json'), JSON.stringify({ ...skeleton, nodeId: 'x.y', decomposition: leaf, featureTasks: [entry] }));
    // A milestone artifact with a missing comma (the 2026-10-30 batch-48 shape):
    // the guard's feedback must name the file, not just report a bare parse error.
    writeFileSync(join(artifactRoot, 'planner', 'milestones', 'M1.json'), '{ "id": "M1", "tasks": [] "logicalRefs": [] }');
    const roles = createDefaultV2Roles({ store: {}, workspace: dir, artifactRoot });
    const task = { id: 'g2', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead', input: { purpose: 'PLANNING_ROUTE' }, history: [] };
    const routed = { outcome: 'PLANNING_ROUTE', result: { stages: {} } };
    const bounced = roles.tech_lead.transition({ task, result: routed });
    assert.equal(bounced.transitionHistory.type, 'PLAN_GATE_RETRY');
    assert.match(bounced.input.previousGateFailure.summary, /M1\.json/);
    assert.match(bounced.transitionHistory.summary, /M1\.json/);
    const exhausted = roles.tech_lead.transition({ task: { ...task, input: { purpose: 'PLANNING_ROUTE', planGateRetries: 2 } }, result: routed });
    assert.equal(exhausted.transitionHistory.type, 'PLAN_DEBUGGER_ROUTED');
    assert.equal(exhausted.stage, 'project_debugger');
    assert.match(exhausted.transitionHistory.summary, /M1\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planning debugger prepare surfaces the gate failure detail', () => {
  const roles = createDefaultV2Roles({ store: {}, workspace: '/tmp' });
  const task = {
    id: 'dbg1', projectId: 'P', taskKind: 'PLANNING', stage: 'project_debugger', history: [],
    input: { previousGateFailure: { stage: 'tech_lead', blockedType: 'ARTIFACT_VALIDATION_FAILED', summary: 'boom | unparseable planner artifacts: planner/milestones/M1.json' } },
  };
  const prepared = roles.project_debugger.prepare({ task });
  assert.match(JSON.stringify(prepared), /ARTIFACT_VALIDATION_FAILED/);
  assert.match(JSON.stringify(prepared), /M1\.json/);
});

test('frontier pass validation failure enters the gate ladder instead of throwing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-frontier-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const artifactRoot = join(dir, 'artifacts');
  const layout = ensureInterfaceArtifactLayout(artifactRoot);
  const write = (file, value) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  // One feature node whose contract predates the behavior layer: its
  // integration scenario carries no acceptanceCriteria. When a frontier
  // pass targets this node, finishFrontierPass throws - the transition
  // must convert that into the planning gate progression, not let it
  // escape and fail the whole project.
  write(join(artifactRoot, 'planner', 'logical', 'project.json'), {
    id: 'project', title: 'project', summary: 'root', parentId: null,
  });
  write(join(layout.featureDir, 'project.json'), {
    version: 1, nodeId: 'project', nodeType: 'feature',
    decomposition: { kind: 'leaf', reason: 'single node fixture' },
    interfaces: [{
      id: 'run', kind: 'executor', visibility: 'exported',
      contract: { input: [], output: ['run result'], sideEffects: [] },
    }],
    imports: [],
    integrationScenarios: [{ id: 'legacy-scenario', description: 'Pre-behavior-layer scenario without acceptance criteria.', uses: [] }],
    bindings: [], featureTasks: [], behavior: ['The project runs.'],
  });
  write(layout.activeFrontierPath, {
    version: 1, nodeType: 'feature', bootstrap: false,
    targetNodeId: 'project', existingNodeParents: { project: null },
  });
  const roles = createDefaultV2Roles({ store: {}, workspace: dir, artifactRoot });
  const task = {
    id: 'tl-1', projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead',
    flowId: 'planner:P:b1', history: [],
    input: { purpose: 'PLANNER_DECOMPOSE', frontierPhase: 'feature', planGateRetries: 0 },
  };
  const first = roles.tech_lead.transition({ task, result: { outcome: 'PLANNED' } });
  assert.equal(first.state, 'READY');
  assert.equal(first.stage, 'tech_lead');
  assert.equal(first.transitionHistory.type, 'PLAN_GATE_RETRY');
  assert.match(first.input.previousGateFailure.summary, /legacy-scenario/);
  const exhausted = roles.tech_lead.transition({
    task: { ...task, input: { ...task.input, planGateRetries: 2 } },
    result: { outcome: 'PLANNED' },
  });
  assert.equal(exhausted.state, 'READY');
  assert.equal(exhausted.stage, 'project_debugger');
  assert.equal(exhausted.transitionHistory.type, 'PLAN_DEBUGGER_ROUTED');
});
