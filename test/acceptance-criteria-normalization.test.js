import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeAcceptanceCriteria,
  acceptanceCriteriaForTask,
  acceptanceCriterionIds,
  aggregateTesterSubmission,
} from '../src/v2/acceptance.js';
import { buildTaskContextArtifact, acceptanceCriterionIdsFor } from '../src/runtime/task-context-artifact.js';
import { persistPlanningState } from '../src/v2/planning-persistence.js';
import { validatePlanAutonomy } from '../src/v2/autonomy.js';
import { VersionedStore } from '../src/v2/versioned-store.js';

// Acceptance-criteria serialization fix (platform defect reported from
// SRPG, 2026-11-27): a task authored with acceptanceCriteria as a single
// string - one prose criterion - was read as ZERO criteria by spec
// export, task-context artifacts and tester aggregation, because every
// derivation required an array. The string form now normalizes to a
// one-element array at every derivation point, and draft validation
// rejects shapes no consumer can read.

test('normalizeAcceptanceCriteria: string is one criterion, unreadable shapes are none', () => {
  assert.deepEqual(normalizeAcceptanceCriteria(['a', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeAcceptanceCriteria('one prose criterion'), ['one prose criterion']);
  assert.deepEqual(normalizeAcceptanceCriteria('   '), []);
  assert.deepEqual(normalizeAcceptanceCriteria(null), []);
  assert.deepEqual(normalizeAcceptanceCriteria(undefined), []);
  assert.deepEqual(normalizeAcceptanceCriteria(42), []);
  assert.deepEqual(normalizeAcceptanceCriteria({ text: 'x' }), []);
});

test('criterion IDs derive from string, array and input-carried criteria alike', () => {
  assert.deepEqual(acceptanceCriterionIds({ acceptanceCriteria: 'solo' }), ['AC1']);
  assert.deepEqual(acceptanceCriterionIds({ acceptanceCriteria: ['a', 'b', 'c'] }), ['AC1', 'AC2', 'AC3']);
  assert.deepEqual(acceptanceCriterionIds({ acceptanceCriteria: null }), []);
  assert.deepEqual(acceptanceCriterionIds({ input: { acceptanceCriteria: 'from input' } }), ['AC1']);
  assert.deepEqual(acceptanceCriteriaForTask({ acceptanceCriteria: 'solo' }), ['solo']);
  assert.deepEqual(acceptanceCriterionIdsFor('solo'), ['AC1']);
});

test('tester aggregation counts a string criterion as required, with its text', () => {
  const task = { id: 't', acceptanceCriteria: 'The journey completes end to end.' };
  const out = aggregateTesterSubmission(task, {
    outcome: 'PASS',
    result: { criteria: [{ criterionId: 'AC1', status: 'SATISFIED', evidenceType: 'runtime', evidence: [] }] },
  });
  assert.equal(out.outcome, 'PASS');
  assert.equal(out.result.aggregate.required, 1);
  assert.equal(out.result.criteria[0].requirement, 'The journey completes end to end.');
});

test('task-context artifact serializes string criteria as a one-element array with AC1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-ac-artifact-'));
  try {
    const artifact = buildTaskContextArtifact({
      task: { id: 't', title: 'T', acceptanceCriteria: 'Solo criterion', history: [] },
      boundaryContext: null,
      artifactRoot: dir,
    });
    assert.deepEqual(artifact.task.acceptanceCriteria, ['Solo criterion']);
    assert.deepEqual(artifact.task.acceptanceCriterionIds, ['AC1']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spec export normalizes string criteria and derives their IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-ac-export-'));
  try {
    const versionedStore = {
      getProdVersion: () => 7,
      listSpecTasks: () => [
        { id: 'str-task', acceptanceCriteria: 'Solo criterion' },
        { id: 'arr-task', acceptanceCriteria: ['a', 'b'] },
        { id: 'none-task', acceptanceCriteria: null },
      ],
      listSpecContracts: () => [],
    };
    const result = persistPlanningState({ workspace: dir, versionedStore, node: 'test' });
    assert.equal(result.specExport, '.ariad/spec-export/prod.json');
    const data = JSON.parse(readFileSync(join(dir, '.ariad', 'spec-export', 'prod.json'), 'utf8'));
    const byId = new Map(data.tasks.map(t => [t.id, t]));
    assert.deepEqual(byId.get('str-task').acceptanceCriteria, ['Solo criterion']);
    assert.deepEqual(byId.get('str-task').acceptanceCriterionIds, ['AC1']);
    assert.deepEqual(byId.get('arr-task').acceptanceCriteria, ['a', 'b']);
    assert.deepEqual(byId.get('arr-task').acceptanceCriterionIds, ['AC1', 'AC2']);
    assert.equal(byId.get('none-task').acceptanceCriterionIds, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('autonomy scan reads string criteria as text, not characters', () => {
  assert.throws(
    () => validatePlanAutonomy({ tasks: [{ id: 't', title: 'T', acceptanceCriteria: 'The owner must test the build by hand.' }] }, []),
    err => err.code === 'INVALID_AUTONOMY_REQUIREMENT' && err.violations.length === 1,
  );
  const ok = validatePlanAutonomy({ tasks: [{ id: 't', title: 'T', acceptanceCriteria: 'Runs unattended.' }] }, []);
  assert.equal(ok.ok, true);
});

test('draft validation rejects an unreadable acceptanceCriteria shape but accepts a string', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-ac-validate-'));
  const store = new VersionedStore(join(dir, 'state.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initProject('proj');
  store.createDraft({ createdBy: 'tl' });
  const contract = {
    id: 'feature.alpha', nodeType: 'feature',
    exportedInterfaces: [{ id: 'alpha_api' }],
    behavior: ['Alpha must charge before it can fire.'],
  };
  assert.throws(
    () => store.applyTreeOps([
      { op: 'upsertContract', contract },
      { op: 'upsertTask', task: { id: 'bad-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Bad', dependsOn: [], interfaceIds: [], acceptanceCriteria: 42 } },
    ]),
    err => JSON.stringify(err.details ?? err.message).includes('acceptanceCriteria'),
  );
  // The rejected call changed nothing; a string criterion applies cleanly.
  store.applyTreeOps([
    { op: 'upsertContract', contract },
    { op: 'upsertTask', task: { id: 'str-task', taskKind: 'FEATURE_TASK', featureId: 'feature.alpha', title: 'Str', dependsOn: [], interfaceIds: [], acceptanceCriteria: 'One prose criterion.' } },
  ]);
  const draft = store.getOpenDraft();
  const tasks = store.listSpecTasks(draft.version);
  assert.equal(tasks.find(x => x.id === 'str-task').acceptanceCriteria, 'One prose criterion.');
});
