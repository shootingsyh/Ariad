import { buildExecutionGraph } from './execution-graph.js';

const HISTORY_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['type', 'summary'],
    additionalProperties: true,
    properties: {
      type: { type: 'string', minLength: 1 },
      summary: { type: 'string', minLength: 1 },
    },
  },
};

const MILESTONE_WORK_KINDS = new Set(['connection', 'reconcile', 'test']);

export const TECH_LEAD_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  required: ['version', 'projectSummary', 'rootTaskId', 'tasks'],
  additionalProperties: false,
  properties: {
    version: { const: 2 },
    projectSummary: { type: 'string', minLength: 1 },
    rootTaskId: { type: 'string', minLength: 1 },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: [
          'id',
          'title',
          'intent',
          'parentId',
          'dependsOn',
          'acceptanceCriteria',
          'testStrategy',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          intent: { type: 'string', minLength: 1 },
          parentId: { type: ['string', 'null'] },
          dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          acceptanceCriteria: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
          testStrategy: { type: 'string', minLength: 1 },
          history: HISTORY_SCHEMA,
        },
      },
    },
    // New plans should always emit this. It remains optional in the schema so older
    // persisted v2 plans can still be loaded and migrated without a flag day.
    milestones: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: [
          'id',
          'title',
          'goal',
          'parentId',
          'dependsOn',
          'logicalTaskIds',
          'workTasks',
          'completionTaskId',
          'acceptanceCriteria',
          'testStrategy',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          goal: { type: 'string', minLength: 1 },
          parentId: { type: ['string', 'null'] },
          dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          logicalTaskIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          workTasks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: [
                'id',
                'title',
                'kind',
                'intent',
                'dependsOn',
                'acceptanceCriteria',
                'testStrategy',
              ],
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1 },
                title: { type: 'string', minLength: 1 },
                kind: { enum: ['connection', 'reconcile', 'test'] },
                intent: { type: 'string', minLength: 1 },
                dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
                acceptanceCriteria: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string', minLength: 1 },
                },
                testStrategy: { type: 'string', minLength: 1 },
                history: HISTORY_SCHEMA,
              },
            },
          },
          completionTaskId: { type: 'string', minLength: 1 },
          acceptanceCriteria: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
          testStrategy: { type: 'string', minLength: 1 },
        },
      },
    },
  },
});

function fail(path, message) {
  const error = new Error(`${path}: ${message}`);
  error.code = 'TECH_LEAD_PLAN_INVALID';
  throw error;
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
}

function assertStringArray(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (nonEmpty && value.length === 0) fail(path, 'must not be empty');
  const seen = new Set();
  value.forEach((item, index) => {
    assertString(item, `${path}[${index}]`);
    if (seen.has(item)) fail(path, `contains duplicate value ${item}`);
    seen.add(item);
  });
}

function normalizeHistory(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(path, 'must be an array');
  value.forEach((entry, index) => {
    const historyPath = `${path}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(historyPath, 'must be an object');
    assertString(entry.type, `${historyPath}.type`);
    assertString(entry.summary, `${historyPath}.summary`);
  });
  return structuredClone(value);
}

function assertAcyclic(ids, dependenciesOf, path, label) {
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail(path, `${label} contains a cycle at ${id}`);
    visiting.add(id);
    for (const dep of dependenciesOf(id)) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of ids) visit(id);
}

function milestonePrerequisiteClosure(milestonesById, milestoneId) {
  const seen = new Set();
  const stack = [...(milestonesById.get(milestoneId)?.dependsOn ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of milestonesById.get(id)?.dependsOn ?? []) stack.push(dep);
  }
  return seen;
}

function addUniqueDependency(task, depId) {
  if (task.id === depId) return;
  if (!task.dependsOn.includes(depId)) task.dependsOn.push(depId);
}

function normalizeMilestones(plan, logicalById) {
  if (plan.milestones == null) return { milestones: [], milestonesById: new Map(), milestoneByLogicalTask: new Map(), workById: new Map() };
  if (!Array.isArray(plan.milestones) || plan.milestones.length === 0) {
    fail('$.milestones', 'must be a non-empty array when present');
  }

  const milestones = [];
  const milestonesById = new Map();
  const milestoneByLogicalTask = new Map();
  const workById = new Map();

  for (let index = 0; index < plan.milestones.length; index += 1) {
    const item = plan.milestones[index];
    const path = `$.milestones[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(path, 'must be an object');
    const allowed = new Set([
      'id', 'title', 'goal', 'parentId', 'dependsOn', 'logicalTaskIds',
      'workTasks', 'completionTaskId', 'acceptanceCriteria', 'testStrategy',
    ]);
    for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unexpected property');

    assertString(item.id, `${path}.id`);
    if (milestonesById.has(item.id)) fail(`${path}.id`, `duplicate milestone id ${item.id}`);
    assertString(item.title, `${path}.title`);
    assertString(item.goal, `${path}.goal`);
    if (item.parentId !== null) assertString(item.parentId, `${path}.parentId`);
    assertStringArray(item.dependsOn, `${path}.dependsOn`);
    assertStringArray(item.logicalTaskIds, `${path}.logicalTaskIds`);
    assertStringArray(item.acceptanceCriteria, `${path}.acceptanceCriteria`, { nonEmpty: true });
    assertString(item.testStrategy, `${path}.testStrategy`);
    assertString(item.completionTaskId, `${path}.completionTaskId`);
    if (!Array.isArray(item.workTasks) || item.workTasks.length === 0) {
      fail(`${path}.workTasks`, 'must contain milestone-owned connection/reconcile/test work');
    }

    const workTasks = item.workTasks.map((task, taskIndex) => {
      const taskPath = `${path}.workTasks[${taskIndex}]`;
      if (!task || typeof task !== 'object' || Array.isArray(task)) fail(taskPath, 'must be an object');
      const allowedTask = new Set([
        'id', 'title', 'kind', 'intent', 'dependsOn', 'acceptanceCriteria', 'testStrategy', 'history',
      ]);
      for (const key of Object.keys(task)) if (!allowedTask.has(key)) fail(`${taskPath}.${key}`, 'unexpected property');
      assertString(task.id, `${taskPath}.id`);
      if (logicalById.has(task.id) || workById.has(task.id)) {
        fail(`${taskPath}.id`, `task id collides with another logical or milestone task: ${task.id}`);
      }
      assertString(task.title, `${taskPath}.title`);
      if (!MILESTONE_WORK_KINDS.has(task.kind)) fail(`${taskPath}.kind`, 'must be connection, reconcile, or test');
      assertString(task.intent, `${taskPath}.intent`);
      assertStringArray(task.dependsOn, `${taskPath}.dependsOn`);
      assertStringArray(task.acceptanceCriteria, `${taskPath}.acceptanceCriteria`, { nonEmpty: true });
      assertString(task.testStrategy, `${taskPath}.testStrategy`);
      const normalized = {
        id: task.id,
        title: task.title,
        kind: task.kind,
        intent: task.intent,
        dependsOn: [...task.dependsOn],
        acceptanceCriteria: [...task.acceptanceCriteria],
        testStrategy: task.testStrategy,
        history: normalizeHistory(task.history, `${taskPath}.history`),
      };
      workById.set(task.id, { ...normalized, milestoneId: item.id });
      return normalized;
    });

    const normalized = {
      id: item.id,
      title: item.title,
      goal: item.goal,
      parentId: item.parentId,
      dependsOn: [...item.dependsOn],
      logicalTaskIds: [...item.logicalTaskIds],
      workTasks,
      completionTaskId: item.completionTaskId,
      acceptanceCriteria: [...item.acceptanceCriteria],
      testStrategy: item.testStrategy,
    };
    milestones.push(normalized);
    milestonesById.set(normalized.id, normalized);
  }

  for (const milestone of milestones) {
    if (milestone.parentId !== null) {
      if (!milestonesById.has(milestone.parentId)) {
        fail(`milestone:${milestone.id}.parentId`, `unknown milestone parent ${milestone.parentId}`);
      }
      if (milestone.parentId === milestone.id) fail(`milestone:${milestone.id}.parentId`, 'must not reference itself');
    }
    for (const depId of milestone.dependsOn) {
      if (!milestonesById.has(depId)) fail(`milestone:${milestone.id}.dependsOn`, `unknown milestone dependency ${depId}`);
      if (depId === milestone.id) fail(`milestone:${milestone.id}.dependsOn`, 'must not depend on itself');
    }

    for (const logicalTaskId of milestone.logicalTaskIds) {
      if (!logicalById.has(logicalTaskId)) {
        fail(`milestone:${milestone.id}.logicalTaskIds`, `unknown logical task ${logicalTaskId}`);
      }
      if (milestoneByLogicalTask.has(logicalTaskId)) {
        fail(
          `milestone:${milestone.id}.logicalTaskIds`,
          `logical task ${logicalTaskId} is already assigned to milestone ${milestoneByLogicalTask.get(logicalTaskId)}`
        );
      }
      milestoneByLogicalTask.set(logicalTaskId, milestone.id);
    }

    const completion = workById.get(milestone.completionTaskId);
    if (!completion || completion.milestoneId !== milestone.id) {
      fail(
        `milestone:${milestone.id}.completionTaskId`,
        'must reference a work task owned by the same milestone'
      );
    }
    if (completion.kind !== 'test') {
      fail(`milestone:${milestone.id}.completionTaskId`, 'must reference a milestone test task');
    }
  }

  assertAcyclic(
    milestones.map(item => item.id),
    id => milestonesById.get(id)?.parentId ? [milestonesById.get(id).parentId] : [],
    '$.milestones',
    'milestone tree'
  );
  assertAcyclic(
    milestones.map(item => item.id),
    id => milestonesById.get(id)?.dependsOn ?? [],
    '$.milestones',
    'milestone dependencies'
  );

  const allTaskIds = new Set([...logicalById.keys(), ...workById.keys()]);
  for (const [id, work] of workById) {
    for (const depId of work.dependsOn) {
      if (!allTaskIds.has(depId)) fail(`milestoneTask:${id}.dependsOn`, `unknown dependency ${depId}`);
      if (depId === id) fail(`milestoneTask:${id}.dependsOn`, 'must not depend on itself');
    }
  }

  return { milestones, milestonesById, milestoneByLogicalTask, workById };
}

function compileExecutionTasks({ logicalTasks, rootTaskId, milestoneState }) {
  const execution = logicalTasks.map(task => ({
    ...structuredClone(task),
    origin: 'logical',
  }));

  if (!milestoneState || milestoneState.milestones.length === 0) return execution;

  const { milestones, milestonesById, milestoneByLogicalTask, workById } = milestoneState;
  const childrenByMilestone = new Map(milestones.map(item => [item.id, []]));
  for (const milestone of milestones) {
    if (milestone.parentId) childrenByMilestone.get(milestone.parentId).push(milestone.id);
  }

  const executionById = new Map(execution.map(task => [task.id, task]));
  const milestoneByTask = new Map(milestoneByLogicalTask);
  for (const [id, work] of workById) {
    milestoneByTask.set(id, work.milestoneId);
    executionById.set(id, {
      id,
      scope: 'delivery',
      state: 'READY',
      stage: work.kind === 'test' ? 'tester' : 'developer',
      parentId: null,
      dependsOn: [...work.dependsOn],
      title: work.title,
      intent: work.intent,
      acceptanceCriteria: [...work.acceptanceCriteria],
      testStrategy: work.testStrategy,
      history: structuredClone(work.history ?? []),
      origin: 'milestone',
      milestoneId: work.milestoneId,
      milestoneKind: work.kind,
    });
  }

  // A milestone dependency is a phase gate. All work assigned to the later
  // milestone waits for the earlier milestone's completion test.
  for (const [taskId, milestoneId] of milestoneByTask) {
    const task = executionById.get(taskId);
    for (const depMilestoneId of milestonesById.get(milestoneId)?.dependsOn ?? []) {
      addUniqueDependency(task, milestonesById.get(depMilestoneId).completionTaskId);
    }
  }

  // Completion is an actual milestone-owned TEST node. It waits for all logical
  // leaves/work owned by the milestone and all child milestone completion tests.
  for (const milestone of milestones) {
    const completion = executionById.get(milestone.completionTaskId);
    for (const logicalTaskId of milestone.logicalTaskIds) addUniqueDependency(completion, logicalTaskId);
    for (const work of milestone.workTasks) {
      if (work.id !== milestone.completionTaskId) addUniqueDependency(completion, work.id);
    }
    for (const childId of childrenByMilestone.get(milestone.id) ?? []) {
      addUniqueDependency(completion, milestonesById.get(childId).completionTaskId);
    }
  }

  // Cross-milestone task dependencies may only point backward through the
  // milestone dependency graph. This prevents an earlier milestone from
  // depending on work that belongs to a future milestone.
  for (const task of executionById.values()) {
    const taskMilestone = milestoneByTask.get(task.id);
    if (!taskMilestone) continue;
    const allowedEarlier = milestonePrerequisiteClosure(milestonesById, taskMilestone);
    for (const depId of task.dependsOn) {
      const depMilestone = milestoneByTask.get(depId);
      if (!depMilestone || depMilestone === taskMilestone) continue;
      if (!allowedEarlier.has(depMilestone)) {
        fail(
          `task:${task.id}.dependsOn`,
          `cross-milestone dependency on ${depId} (${depMilestone}) is not allowed from ${taskMilestone}; add the milestone prerequisite instead`
        );
      }
    }
  }

  // Whole-project logical completion waits for every top-level milestone gate.
  const root = executionById.get(rootTaskId);
  for (const milestone of milestones.filter(item => item.parentId === null)) {
    addUniqueDependency(root, milestone.completionTaskId);
  }

  return [...executionById.values()];
}

export function validateTechLeadPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('$', 'must be an object');
  const allowedTop = new Set(['version', 'projectSummary', 'rootTaskId', 'tasks', 'milestones', 'executionTasks']);
  for (const key of Object.keys(plan)) if (!allowedTop.has(key)) fail(`$.${key}`, 'unexpected property');

  if (plan.version !== 2) fail('$.version', 'must equal 2');
  assertString(plan.projectSummary, '$.projectSummary');
  assertString(plan.rootTaskId, '$.rootTaskId');
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) fail('$.tasks', 'must be a non-empty array');

  const byId = new Map();
  const normalized = [];

  for (let index = 0; index < plan.tasks.length; index += 1) {
    const task = plan.tasks[index];
    const path = `$.tasks[${index}]`;
    if (!task || typeof task !== 'object' || Array.isArray(task)) fail(path, 'must be an object');

    const allowed = new Set([
      'id',
      'title',
      'intent',
      'parentId',
      'dependsOn',
      'acceptanceCriteria',
      'testStrategy',
      'history',
    ]);
    for (const key of Object.keys(task)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unexpected property');

    assertString(task.id, `${path}.id`);
    if (byId.has(task.id)) fail(`${path}.id`, `duplicate task id ${task.id}`);
    assertString(task.title, `${path}.title`);
    assertString(task.intent, `${path}.intent`);
    if (task.parentId !== null) assertString(task.parentId, `${path}.parentId`);
    assertStringArray(task.dependsOn, `${path}.dependsOn`);
    assertStringArray(task.acceptanceCriteria, `${path}.acceptanceCriteria`, { nonEmpty: true });
    assertString(task.testStrategy, `${path}.testStrategy`);

    const normalizedTask = {
      id: task.id,
      scope: 'delivery',
      state: 'READY',
      stage: 'developer',
      parentId: task.parentId,
      dependsOn: [...task.dependsOn],
      title: task.title,
      intent: task.intent,
      acceptanceCriteria: [...task.acceptanceCriteria],
      testStrategy: task.testStrategy,
      history: normalizeHistory(task.history, `${path}.history`),
    };
    byId.set(task.id, normalizedTask);
    normalized.push(normalizedTask);
  }

  const root = byId.get(plan.rootTaskId);
  if (!root) fail('$.rootTaskId', 'does not reference a task');
  if (root.parentId !== null) fail('$.rootTaskId', 'root task must have parentId null');

  const roots = normalized.filter(task => task.parentId === null);
  if (roots.length !== 1) fail('$.tasks', `must contain exactly one logical root; found ${roots.length}`);
  if (roots[0].id !== plan.rootTaskId) fail('$.rootTaskId', 'must identify the only logical root');

  for (const task of normalized) {
    if (task.parentId !== null) {
      if (!byId.has(task.parentId)) fail(`task:${task.id}.parentId`, `unknown parent ${task.parentId}`);
      if (task.dependsOn.includes(task.parentId)) {
        fail(`task:${task.id}.dependsOn`, 'must not repeat parent/child ordering; child-to-parent is a virtual dependency');
      }
    }
    for (const depId of task.dependsOn) {
      if (!byId.has(depId)) fail(`task:${task.id}.dependsOn`, `unknown dependency ${depId}`);
      if (depId === task.id) fail(`task:${task.id}.dependsOn`, 'must not depend on itself');
    }
  }

  // Validate the logical tree independently before milestone execution work is added.
  try {
    buildExecutionGraph(normalized);
  } catch (error) {
    fail('$.tasks', error?.message ?? String(error));
  }

  const milestoneState = normalizeMilestones(plan, byId);
  if (milestoneState?.milestoneByLogicalTask?.has(plan.rootTaskId)) {
    fail('$.milestones', 'the logical project root must not be assigned inside a milestone');
  }

  const executionTasks = compileExecutionTasks({
    logicalTasks: normalized,
    rootTaskId: plan.rootTaskId,
    milestoneState,
  });

  try {
    buildExecutionGraph(executionTasks);
  } catch (error) {
    fail('$.milestones', error?.message ?? String(error));
  }

  return {
    ok: true,
    plan: {
      version: 2,
      projectSummary: plan.projectSummary,
      rootTaskId: plan.rootTaskId,
      tasks: normalized.map(task => ({
        id: task.id,
        title: task.title,
        intent: task.intent,
        parentId: task.parentId,
        dependsOn: [...task.dependsOn],
        acceptanceCriteria: [...task.acceptanceCriteria],
        testStrategy: task.testStrategy,
        history: structuredClone(task.history ?? []),
      })),
      ...(milestoneState && milestoneState.milestones.length > 0
        ? { milestones: structuredClone(milestoneState.milestones) }
        : {}),
      executionTasks: executionTasks.map(task => structuredClone(task)),
    },
  };
}
