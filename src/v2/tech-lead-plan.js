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
          milestoneId: { type: ['string', 'null'] },
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

function normalizeMilestones(plan, logicalById) {
  if (plan.milestones == null) {
    return { milestones: [], milestonesById: new Map() };
  }
  if (!Array.isArray(plan.milestones) || plan.milestones.length === 0) {
    fail('$.milestones', 'must be a non-empty array when present');
  }

  const milestones = [];
  const milestonesById = new Map();

  for (let index = 0; index < plan.milestones.length; index += 1) {
    const item = plan.milestones[index];
    const path = `$.milestones[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(path, 'must be an object');

    const allowed = new Set([
      'id', 'title', 'goal', 'parentId', 'dependsOn', 'logicalTaskIds', 'acceptanceCriteria', 'testStrategy',
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

    const normalized = {
      id: item.id,
      title: item.title,
      goal: item.goal,
      parentId: item.parentId,
      dependsOn: [...item.dependsOn],
      logicalTaskIds: [...item.logicalTaskIds],
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

  return { milestones, milestonesById };
}

export function validateTechLeadPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('$', 'must be an object');
  const allowedTop = new Set(['version', 'projectSummary', 'rootTaskId', 'tasks', 'milestones']);
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
      'milestoneId',
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
    if (task.milestoneId != null) assertString(task.milestoneId, `${path}.milestoneId`);
    assertStringArray(task.acceptanceCriteria, `${path}.acceptanceCriteria`, { nonEmpty: true });
    assertString(task.testStrategy, `${path}.testStrategy`);

    const normalizedTask = {
      id: task.id,
      scope: 'delivery',
      state: 'READY',
      stage: 'developer',
      parentId: task.parentId,
      dependsOn: [...task.dependsOn],
      milestoneId: task.milestoneId ?? null,
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

  const milestoneState = normalizeMilestones(plan, byId);
  if (root.milestoneId != null) {
    fail(`task:${root.id}.milestoneId`, 'the logical project root must not belong to a milestone');
  }

  if (milestoneState.milestones.length > 0) {
    for (const task of normalized) {
      if (task.milestoneId != null && !milestoneState.milestonesById.has(task.milestoneId)) {
        fail(`task:${task.id}.milestoneId`, `unknown milestone ${task.milestoneId}`);
      }
    }

    for (const milestone of milestoneState.milestones) {
      for (const taskId of milestone.logicalTaskIds) {
        const task = byId.get(taskId);
        if (task.milestoneId == null) task.milestoneId = milestone.id;
        else if (task.milestoneId !== milestone.id) {
          fail(
            `milestone:${milestone.id}.logicalTaskIds`,
            `task ${taskId} already belongs to milestone ${task.milestoneId}`
          );
        }
      }
    }

    for (const task of normalized) {
      if (!task.milestoneId) continue;
      const allowedEarlier = milestonePrerequisiteClosure(milestoneState.milestonesById, task.milestoneId);
      for (const depId of task.dependsOn) {
        const dep = byId.get(depId);
        if (!dep?.milestoneId || dep.milestoneId === task.milestoneId) continue;
        if (!allowedEarlier.has(dep.milestoneId)) {
          fail(
            `task:${task.id}.dependsOn`,
            `cross-milestone dependency on ${depId} (${dep.milestoneId}) is not allowed from ${task.milestoneId}; add the prerequisite milestone relationship or change the task structure`
          );
        }
      }
    }
  }

  try {
    buildExecutionGraph(normalized);
  } catch (error) {
    fail('$.tasks', error?.message ?? String(error));
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
        milestoneId: task.milestoneId ?? null,
        acceptanceCriteria: [...task.acceptanceCriteria],
        testStrategy: task.testStrategy,
        history: structuredClone(task.history ?? []),
      })),
      ...(milestoneState.milestones.length > 0
        ? { milestones: structuredClone(milestoneState.milestones) }
        : {}),
    },
  };
}
