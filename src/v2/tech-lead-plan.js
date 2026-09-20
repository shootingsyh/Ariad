import { buildExecutionGraph } from './execution-graph.js';

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
          history: {
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
          },
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

export function validateTechLeadPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('$', 'must be an object');
  const allowedTop = new Set(['version', 'projectSummary', 'rootTaskId', 'tasks']);
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
    if (task.history != null) {
      if (!Array.isArray(task.history)) fail(`${path}.history`, 'must be an array');
      task.history.forEach((entry, historyIndex) => {
        const historyPath = `${path}.history[${historyIndex}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(historyPath, 'must be an object');
        assertString(entry.type, `${historyPath}.type`);
        assertString(entry.summary, `${historyPath}.summary`);
      });
    }

    const normalizedTask = {
      id: task.id,
      scope: 'delivery',
      state: 'READY',
      parentId: task.parentId,
      dependsOn: [...task.dependsOn],
      title: task.title,
      intent: task.intent,
      acceptanceCriteria: [...task.acceptanceCriteria],
      testStrategy: task.testStrategy,
      history: structuredClone(task.history ?? []),
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
        acceptanceCriteria: [...task.acceptanceCriteria],
        testStrategy: task.testStrategy,
        history: structuredClone(task.history ?? []),
      })),
    },
  };
}
