import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plannerFlowTasks, usesThreePassFlow } from '../src/v2/planner-flow.js';
import { planningPhaseSkipIds } from '../src/v2/planning-helpers.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { plannerPrompt, criticPrompt } from '../src/v2/role-prompts.js';
import { buildTechLeadPrompt } from '../src/v2/tech-lead-prompt.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { recordRequirementsApproval } from '../src/v2/project-docs.js';

// Three-pass feature pipeline (owner decision, 2026-11-01): the single
// Tech Lead decomposition of a version-planning batch is split into
// (1) functional features, (2) non-functional features, (3) interfaces +
// tasks. Each feature pass is closed by the deterministic validator and
// the critic - never an intermediate PM gate - and the PM reviews the
// complete plan once at the end. Support relationships are declared as
// plain text in the feature documents (a Supports line); no new schema.

const req = purpose => [{ id: `r-${purpose}`, request: { purpose }, context: {} }];

test('version-planning batches use the three-pass flow', () => {
  for (const purpose of ['INITIAL_PLAN', 'UPDATE_DELIVERY_PLAN']) {
    assert.equal(usesThreePassFlow(req(purpose)), true, purpose);
    const tasks = plannerFlowTasks('batch-1-1', req(purpose));
    const names = tasks.map(t => t.id.replace('planner:batch-1-1:', ''));
    assert.deepEqual(names, [
      'features-functional', 'validate-functional', 'critic-functional', 'repair-functional',
      'features-nonfunctional', 'validate-nonfunctional', 'critic-nonfunctional', 'repair-nonfunctional',
      'decompose', 'dependencies',
      'validate-1', 'critic-1', 'repair-1',
      'validate-2', 'critic-2', 'repair-2',
      'validate-3', 'critic-3', 'repair-3',
      'final-validate', 'pm-review',
    ]);
    const byName = Object.fromEntries(tasks.map(t => [t.id.replace('planner:batch-1-1:', ''), t]));
    assert.equal(byName['features-functional'].input.purpose, 'PLANNER_FEATURES_FUNCTIONAL');
    assert.equal(byName['features-functional'].input.phase, 'functional');
    assert.equal(byName['validate-functional'].input.purpose, 'PLANNER_VALIDATE_FEATURES');
    assert.equal(byName['critic-nonfunctional'].input.purpose, 'PLANNER_CRITIC_FEATURES');
    assert.equal(byName['critic-nonfunctional'].input.phase, 'nonfunctional');
    assert.deepEqual(byName['features-nonfunctional'].dependsOn, ['planner:batch-1-1:repair-functional']);
    assert.deepEqual(byName['decompose'].dependsOn, ['planner:batch-1-1:repair-nonfunctional']);
    assert.equal(byName['decompose'].input.threePass, true);
    assert.equal(byName['pm-review'].input.purpose, 'PLANNER_PM_REVIEW');
  }
});

test('non-version batches keep the single-pass flow', () => {
  for (const purpose of ['TRIAGE_AND_ASSIGN_ISSUE', 'PM_PLAN_REVISION', 'REPLAN_TASK', 'PRODUCT_DECISION_REPLAN']) {
    assert.equal(usesThreePassFlow(req(purpose)), false, purpose);
    const tasks = plannerFlowTasks('batch-3-3', req(purpose));
    assert.equal(tasks.length, 13, purpose);
    assert.equal(tasks[0].id, 'planner:batch-3-3:decompose');
    assert.equal(tasks[0].dependsOn, undefined);
    assert.equal(tasks[0].input.threePass, undefined);
  }
  const authoring = plannerFlowTasks('batch-r', [{ id: 'x', request: { purpose: 'REQUIREMENTS_AUTHORING' }, context: {} }]);
  assert.equal(authoring.length, 1);
  assert.equal(authoring[0].input.purpose, 'REQUIREMENTS_AUTHORING');
});

test('planningPhaseSkipIds names only the phase repair task', () => {
  const base = { input: { planningBatchId: 'batch-2-2', purpose: 'PLANNER_CRITIC_FEATURES', phase: 'functional' } };
  assert.deepEqual(planningPhaseSkipIds(base), ['planner:batch-2-2:repair-functional']);
  assert.deepEqual(
    planningPhaseSkipIds({ input: { planningBatchId: 'batch-2-2', purpose: 'PLANNER_CRITIC_FEATURES', phase: 'nonfunctional' } }),
    ['planner:batch-2-2:repair-nonfunctional'],
  );
  assert.deepEqual(planningPhaseSkipIds({ input: { planningBatchId: 'batch-2-2', purpose: 'PLANNER_CRITIC', round: 1 } }), []);
});

test('a clean phase critic skips only its own phase repair', () => {
  const roles = createDefaultV2Roles({ store: { listPlanningRequests: () => [] }, workspace: '/tmp' });
  const task = {
    id: 'planner:batch-2-2:critic-functional', projectId: 'P', taskKind: 'PLANNING',
    stage: 'tech_lead_critic', flowId: 'planner:P:batch-2-2',
    input: { planningBatchId: 'batch-2-2', purpose: 'PLANNER_CRITIC_FEATURES', phase: 'functional' },
    history: [],
  };
  const out = roles.tech_lead_critic.transition({ task, result: { outcome: 'CLEAN', summary: 'ok', result: {} } });
  assert.equal(out.state, 'DONE');
  assert.deepEqual(out.skipTaskIds, ['planner:batch-2-2:repair-functional']);
});

function phaseValidatorSetup({ withDraft = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-phaseval-'));
  const dbPath = join(dir, 'state2.db');
  if (withDraft) {
    const vs = new VersionedStore(dbPath);
    vs.initProject('P');
    vs.createDraft({ createdBy: 'tl' });
    vs.applyTreeOps([
      { op: 'upsertContract', contract: { id: 'feature.alpha', nodeType: 'feature', behavior: ['Alpha behaves.'] } },
    ]);
    vs.close();
  }
  const store = { filePath: dbPath, getProject: () => ({ id: 'P', versionedTree: true, workspace: dir, goal: 'G', mode: 'STANDARD' }) };
  const roles = createDefaultV2Roles({ store, workspace: dir, enqueuePlanning: () => {} });
  const prepared = roles.plan_validator.prepare({
    task: { id: 'vf', projectId: 'P', taskKind: 'PLANNING', stage: 'plan_validator', history: [], input: { purpose: 'PLANNER_VALIDATE_FEATURES', phase: 'functional' } },
  });
  return { dir, prepared };
}

test('phase validator passes a contracts-only draft and carries the contracts', async () => {
  const { prepared } = phaseValidatorSetup();
  const out = await prepared.execute();
  assert.equal(out.outcome, 'PASS');
  assert.equal(out.result.plan.source, 'db-draft-features');
  assert.equal(out.result.plan.phase, 'functional');
  assert.equal(out.result.plan.contractCount, 1);
  assert.equal(out.result.plan.contracts[0].id, 'feature.alpha');
});

test('phase validator fails when no draft is open', async () => {
  const { prepared } = phaseValidatorSetup({ withDraft: false });
  const out = await prepared.execute();
  assert.equal(out.outcome, 'NOT_PASS');
  assert.equal(out.result.errorCode, 'NO_OPEN_DRAFT');
});

test('phase validator blocks a changed feature without its document, then passes once documented', async () => {
  const { dir, prepared } = phaseValidatorSetup();
  const docs = join(dir, '.ariad', 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  writeFileSync(join(docs, 'REQUIREMENTS.md'), '# Requirements\n\n## 1. Alpha\nAlpha must behave.\n');
  recordRequirementsApproval(dir, { approvedBy: 'test' });
  writeFileSync(join(docs, 'FEATURES.md'), '# Features\n');
  const blocked = await prepared.execute();
  assert.equal(blocked.outcome, 'NOT_PASS');
  assert.equal(blocked.result.errorCode, 'PROJECT_DOCS_INCOMPLETE');
  assert.match(blocked.result.error, /feature\.alpha/);
  writeFileSync(join(docs, 'features', 'feature.alpha.md'), '# Alpha\n\nSupports: REQUIREMENTS section 1 (Alpha).\n');
  writeFileSync(join(docs, 'FEATURES.md'), '# Features\n\n- feature.alpha\n');
  const passed = await prepared.execute();
  assert.equal(passed.outcome, 'PASS');
});

test('feature pass prompts carry the split, the Supports rule and the accounting', () => {
  const store = { listPlanningRequests: () => [], listTasks: () => [] };
  const project = { id: 'P', spec: 'spec', mode: 'NEW' };
  const functional = plannerPrompt({ store, project, artifactRoot: '/tmp', task: { id: 't1', projectId: 'P', input: { purpose: 'PLANNER_FEATURES_FUNCTIONAL', phase: 'functional', requests: [] } } });
  assert.match(functional, /feature pass 1 of 3/);
  assert.match(functional, /Supports line/);
  assert.match(functional, /SUPPORTS ACCOUNTING/);
  assert.match(functional, /no separate schema/);
  const nonfunctional = plannerPrompt({ store, project, artifactRoot: '/tmp', task: { id: 't2', projectId: 'P', input: { purpose: 'PLANNER_FEATURES_NONFUNCTIONAL', phase: 'nonfunctional', requests: [] } } });
  assert.match(nonfunctional, /feature pass 2 of 3/);
  assert.match(nonfunctional, /naming the functional feature it serves/);
  const pass3 = plannerPrompt({ store, project, artifactRoot: '/tmp', task: { id: 't3', projectId: 'P', input: { purpose: 'PLANNER_DECOMPOSE', threePass: true, requests: [] } } });
  assert.match(pass3, /FEATURE PASS 3 OF 3/);
  const legacy = plannerPrompt({ store, project, artifactRoot: '/tmp', task: { id: 't4', projectId: 'P', input: { purpose: 'PLANNER_DECOMPOSE', requests: [] } } });
  assert.doesNotMatch(legacy, /FEATURE PASS 3 OF 3/);
  assert.match(buildTechLeadPrompt({ projectContext: {}, schema: null }), /Supports declarations/);
});

test('phase critic prompts judge alignment, supports and ambiguity for their pass only', () => {
  const flow = 'planner:P:batch-9-9';
  const mk = phase => {
    const validate = {
      id: `planner:batch-9-9:validate-${phase}`, projectId: 'P', flowId: flow,
      history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { valid: true, phase, plan: { source: 'db-draft-features', phase, contracts: [] } } }],
    };
    const criticTask = {
      id: `planner:batch-9-9:critic-${phase}`, projectId: 'P', taskKind: 'PLANNING', stage: 'tech_lead_critic',
      flowId: flow, input: { planningBatchId: 'batch-9-9', purpose: 'PLANNER_CRITIC_FEATURES', phase },
      dependsOn: [validate.id], history: [],
    };
    const store = { listPlanningRequests: () => [], listTasks: () => [validate, criticTask] };
    return criticPrompt({ store, project: { id: 'P', spec: 'spec' }, task: criticTask, artifactRoot: '/tmp' });
  };
  const functional = mk('functional');
  assert.match(functional, /feature pass 1 of 3/);
  assert.match(functional, /SUPPORTS/);
  assert.match(functional, /NO AMBIGUITY/);
  const nonfunctional = mk('nonfunctional');
  assert.match(nonfunctional, /feature pass 2 of 3/);
  assert.match(nonfunctional, /serves/);
  assert.match(nonfunctional, /INTEGRITY/);
});
