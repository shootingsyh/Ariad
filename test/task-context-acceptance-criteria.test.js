import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceCriterionIdsFor,
  buildTaskContextArtifact,
} from '../src/runtime/task-context-artifact.js';
import {
  resolveRequiredCriterionIds,
  validateTestPlanCoverage,
} from '../src/runtime/test-plan-coverage.js';

// Fixture: the six acceptance criteria of T-fix-battlefield-location-routing
// as defined by the project spec (v141 text, identical in v142; restored to
// prod by the fix-task-context-acceptance-criteria-serialization repair).
const LOCATION_ROUTING_CRITERIA = [
  '山门、后山、坠星泽、青阳等地点各有可辨识的面貌，不得以同一套通用地块换色覆盖全游戏。',
  "For every mapped location, the runtime grid uses the location's formal tileset: shanmen uses res://assets/art/tiles/tileset_shanmen.png; houshan and qingyang use res://assets/art/tiles/tileset_qingyang_full.png; zhuixingze uses res://assets/art/tiles/tileset_zhuixingze.png; xueheyuan uses res://assets/art/tiles/tileset_xueheyuan.png.",
  'For a normal battle entered with ch01 (shanmen), hx1 (houshan), ch25a (shanmen), and hx3 (qingyang), every scattered prop texture belongs to GridManager.PROP_POOLS for that map_data.location, including shanmen gate/pillar/banner/roadstone/pine and houshan pine/deadwood/bamboo/roadstone pools rather than the chapter-region fallback pool.',
  'Maps whose location is absent or not a supported location retain the existing region_for_map fallback and do not fail battle startup or tile loading.',
  '地形自解释可读性：该地点每格地形类别（草地、林地、水面、城塞、沼泽、高台等）仅凭美术本身在去掉一切面板与文字的纯渲染帧上逐格可判读，单看纯渲染帧判读不出即不合格，图例显得必要即视为美术不可读。',
  '正常玩家入口下受影响地点的当前构建真实渲染帧 must be visually reviewed for location recognizability and the scene effect from formal location tiles/prop pools; runtime atlas/prop-pool assertions are supplemental and cannot replace visual judgement.',
];

test('serializer exposes every spec criterion and its stable IDs (T-fix-battlefield-location-routing case)', () => {
  const task = {
    id: 'T-fix-battlefield-location-routing',
    title: 'Repair battlefield location-to-tileset and prop-pool routing',
    intent: 'Repair location routing',
    acceptanceCriteria: [...LOCATION_ROUTING_CRITERIA],
    testStrategy: 'deterministic regression fixture',
    history: [],
  };
  const artifact = buildTaskContextArtifact({ task, boundaryContext: null });
  assert.deepEqual(artifact.task.acceptanceCriteria, LOCATION_ROUTING_CRITERIA);
  assert.deepEqual(artifact.task.acceptanceCriterionIds, ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']);
  // ID/text correspondence: ACn is exactly criterion n.
  LOCATION_ROUTING_CRITERIA.forEach((criterion, index) => {
    assert.equal(artifact.task.acceptanceCriteria[index], criterion);
    assert.equal(artifact.task.acceptanceCriterionIds[index], `AC${index + 1}`);
  });
});

test('serializer derives IDs from task.input criteria when the spec side is empty', () => {
  const task = {
    id: 'T-input-criteria',
    title: 'Input-side criteria',
    history: [],
    input: { acceptanceCriteria: ['first', 'second'] },
  };
  const artifact = buildTaskContextArtifact({ task, boundaryContext: null });
  assert.deepEqual(artifact.task.acceptanceCriteria, ['first', 'second']);
  assert.deepEqual(artifact.task.acceptanceCriterionIds, ['AC1', 'AC2']);
});

test('serializer keeps a criteria-empty task explicitly empty without borrowing', () => {
  const empty = { id: 'T-empty', title: 'No criteria defined', history: [] };
  const artifact = buildTaskContextArtifact({ task: empty, boundaryContext: null });
  assert.deepEqual(artifact.task.acceptanceCriteria, []);
  assert.deepEqual(artifact.task.acceptanceCriterionIds, []);
  // A sibling task with criteria must not leak into it.
  const sibling = buildTaskContextArtifact({
    task: { ...empty, acceptanceCriteria: ['sibling criterion'] },
    boundaryContext: null,
  });
  assert.deepEqual(sibling.task.acceptanceCriterionIds, ['AC1']);
  assert.deepEqual(artifact.task.acceptanceCriteria, []);
});

test('acceptanceCriterionIdsFor is positional and stable', () => {
  assert.deepEqual(acceptanceCriterionIdsFor(['a', 'b', 'c']), ['AC1', 'AC2', 'AC3']);
  assert.deepEqual(acceptanceCriterionIdsFor([]), []);
  assert.deepEqual(acceptanceCriterionIdsFor(undefined), []);
});

test('coverage validator accepts a plan covering exactly the artifact IDs', () => {
  const artifact = buildTaskContextArtifact({
    task: { id: 'T-fix-battlefield-location-routing', acceptanceCriteria: [...LOCATION_ROUTING_CRITERIA], history: [] },
    boundaryContext: null,
  });
  // The task context the role sees carries the artifact's criteria/IDs.
  const taskContext = {
    acceptanceCriteria: artifact.task.acceptanceCriteria,
    acceptanceCriterionIds: artifact.task.acceptanceCriterionIds,
  };
  const plan = [
    { id: 'TC1', entry: 'e2e/battlefield', command: 'godot --headless', covers: ['AC1', 'AC2', 'AC3'], executionScope: ['e2e'] },
    { id: 'TC2', entry: 'e2e/fallback', command: 'godot --headless', covers: ['AC4'], executionScope: ['e2e'] },
    { id: 'TC3', entry: 'vision/review', command: 'vision review', covers: ['AC5', 'AC6'], executionScope: ['journey'] },
  ];
  const verdict = validateTestPlanCoverage(taskContext, plan);
  assert.deepEqual(verdict.required, ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']);
  assert.equal(verdict.cases, 3);
});

test('coverage validator derives allowed IDs from the spec criteria when the explicit list is missing (no "Allowed: []")', () => {
  // The reported regression: context carried the criteria but no derived ID
  // list; the validator must not collapse to an empty allowed set.
  const taskContext = { acceptanceCriteria: [...LOCATION_ROUTING_CRITERIA] };
  assert.deepEqual(resolveRequiredCriterionIds(taskContext), ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']);
  const plan = [
    { id: 'TC1', entry: 'e', command: 'c', covers: ['AC1', 'AC2', 'AC3', 'AC4'], executionScope: [] },
    { id: 'TC2', entry: 'e', command: 'c', covers: ['AC5', 'AC6'], executionScope: [] },
  ];
  assert.equal(validateTestPlanCoverage(taskContext, plan).cases, 2);
});

test('coverage validator rejects unknown criterion IDs and reports the allowed set', () => {
  const taskContext = { acceptanceCriteria: [...LOCATION_ROUTING_CRITERIA] };
  const plan = [
    { id: 'TC1', entry: 'e', command: 'c', covers: ['AC1', 'AC7'], executionScope: [] },
    { id: 'TC2', entry: 'e', command: 'c', covers: ['AC2', 'AC3', 'AC4', 'AC5', 'AC6'], executionScope: [] },
  ];
  assert.throws(() => validateTestPlanCoverage(taskContext, plan), error => {
    assert.equal(error.code, 'ARIAD_TEST_PLAN_COVERAGE_INVALID');
    assert.deepEqual(error.invalid, ['AC7']);
    assert.deepEqual(error.required, ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']);
    assert.match(String(error.message), /Allowed: \["AC1","AC2","AC3","AC4","AC5","AC6"\]/);
    return true;
  });
});

test('coverage validator rejects a plan that omits a required criterion', () => {
  const taskContext = { acceptanceCriteria: ['only one'] };
  assert.throws(() => validateTestPlanCoverage(taskContext, []), error => {
    assert.equal(error.code, 'ARIAD_TEST_PLAN_COVERAGE_INVALID');
    assert.deepEqual(error.missing, ['AC1']);
    return true;
  });
  assert.throws(() => validateTestPlanCoverage(taskContext, [
    { id: 'TC1', entry: 'e', command: 'c', covers: [], executionScope: [] },
  ]), error => {
    assert.deepEqual(error.missing, ['AC1']);
    return true;
  });
  // A single case that fully covers the required ID is accepted.
  assert.equal(validateTestPlanCoverage(taskContext, [
    { id: 'TC1', entry: 'e', command: 'c', covers: ['AC1'], executionScope: [] },
  ]).cases, 1);
});
