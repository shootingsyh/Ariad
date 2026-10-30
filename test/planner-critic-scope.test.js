import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { criticPrompt } from '../src/v2/role-prompts.js';

// Batch-47 regression (2026-10-29): a triage-only batch for a duplicate
// issue report was escalated by the delivery-plan critic into plan-wide
// dependency surgery; the repair rounds then corrupted two milestone
// artifacts and parked the project. Two guards:
//  - the batch critic prompt is scoped to what the batch itself produced
//    or changed (pre-existing plan properties are observations only);
//  - for triage-only batches the critic is advisory: ISSUES are recorded
//    on the task but never open repair rounds.

const triageRows = [{
  batchId: 'batch-9-9',
  request: {
    purpose: 'TRIAGE_AND_ASSIGN_ISSUE',
    issueId: 'issue:x',
    issue: { title: 'flake title' },
  },
}];
const planRows = [{ batchId: 'batch-9-9', request: { purpose: 'UPDATE_DELIVERY_PLAN' } }];

const criticTask = {
  id: 'planner:batch-9-9:critic-1',
  projectId: 'P',
  taskKind: 'PLANNING',
  stage: 'tech_lead_critic',
  flowId: 'planner:P:batch-9-9',
  input: { planningBatchId: 'batch-9-9', purpose: 'PLANNER_CRITIC', round: 1 },
  dependsOn: ['planner:batch-9-9:validate-1'],
  history: [],
};

const issuesResult = {
  outcome: 'ISSUES',
  summary: 'critic summary',
  result: { issues: [{ message: 'pre-existing fan-in', severity: 'major' }], summary: 'critic summary' },
};

test('triage-only batch: critic ISSUES are advisory and skip the repair rounds', () => {
  const roles = createDefaultV2Roles({ store: { listPlanningRequests: () => triageRows }, workspace: '/tmp' });
  const out = roles.tech_lead_critic.transition({ task: criticTask, result: issuesResult });
  assert.equal(out.state, 'DONE');
  assert.ok(out.skipTaskIds?.includes('planner:batch-9-9:repair-1'), 'skips repair-1');
  assert.ok(out.skipTaskIds?.includes('planner:batch-9-9:repair-3'), 'skips repair-3');
  assert.equal(out.transitionHistory?.type, 'CRITIC_ADVISORY_ONLY');
  assert.equal(out.transitionHistory?.issues?.length, 1);
  assert.equal(out.transitionHistory?.issues?.[0]?.message, 'pre-existing fan-in');
});

test('plan-authoring batch: critic ISSUES still open the repair rounds', () => {
  const roles = createDefaultV2Roles({ store: { listPlanningRequests: () => planRows }, workspace: '/tmp' });
  const out = roles.tech_lead_critic.transition({ task: criticTask, result: issuesResult });
  assert.equal(out.state, 'DONE');
  assert.equal(out.skipTaskIds, undefined);
  assert.equal(out.transitionHistory, undefined);
});

test('triage-only batch: critic CLEAN keeps the standard skip path', () => {
  const roles = createDefaultV2Roles({ store: { listPlanningRequests: () => triageRows }, workspace: '/tmp' });
  const out = roles.tech_lead_critic.transition({
    task: criticTask,
    result: { outcome: 'CLEAN', summary: 'ok', result: {} },
  });
  assert.equal(out.state, 'DONE');
  assert.ok(out.skipTaskIds?.length > 0);
  assert.equal(out.transitionHistory, undefined);
});

test('batch critic prompt is scoped to the batch and carries its context', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'ariad-critic-prompt-'));
  const flow = 'planner:P:batch-9-9';
  const decompose = {
    id: 'planner:batch-9-9:decompose', projectId: 'P', flowId: flow,
    history: [{ type: 'ROLE_RESULT', role: 'tech_lead', outcome: 'PLANNED', summary: 'Triaged as DUPLICATE_ALREADY_ASSIGNED.' }],
  };
  const dependencies = {
    id: 'planner:batch-9-9:dependencies', projectId: 'P', flowId: flow,
    history: [{ type: 'ROLE_RESULT', role: 'tech_lead', outcome: 'PLANNED', summary: 'No dependency change.' }],
  };
  const validate = {
    id: 'planner:batch-9-9:validate-1', projectId: 'P', flowId: flow,
    history: [{ type: 'ROLE_RESULT', role: 'plan_validator', outcome: 'PASS', result: { plan: null } }],
  };
  const store = {
    listPlanningRequests: () => triageRows,
    listTasks: () => [decompose, dependencies, validate, criticTask],
  };
  const prompt = criticPrompt({ store, project: { id: 'P', spec: 'spec' }, task: criticTask, artifactRoot });
  assert.ok(prompt.includes('BATCH SCOPE'), 'scope banner present');
  assert.ok(prompt.includes('out of scope'), 'out-of-scope rule present');
  assert.ok(prompt.includes('result.observations'), 'observations channel named');
  assert.ok(prompt.includes('flake title'), 'batch request title included');
  assert.ok(prompt.includes('DUPLICATE_ALREADY_ASSIGNED'), 'tech lead disposition included');
});
