import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildExecutionGraph } from './execution-graph.js';

const ID_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function fail(path, message) {
  const error = new Error(`${path}: ${message}`);
  error.code = 'PLANNER_ARTIFACT_INVALID';
  throw error;
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
}

function assertId(value, path) {
  assertString(value, path);
  if (!ID_RE.test(value)) fail(path, 'must use flat dotted-id syntax (letters, digits, _, -, and . only)');
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

function scanFlatJsonDirectory(dir, kind) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) fail(kind, `subdirectories are not allowed: ${entry.name}`);
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const path = join(dir, entry.name);
      let value;
      try {
        value = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        fail(`${kind}/${entry.name}`, `invalid JSON: ${error?.message ?? String(error)}`);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${kind}/${entry.name}`, 'must contain one JSON object');
      assertId(value.id, `${kind}/${entry.name}.id`);
      const fileId = basename(entry.name, '.json');
      if (value.id !== fileId) fail(`${kind}/${entry.name}.id`, `must equal filename id ${fileId}`);
      return value;
    });
}

export function ensurePlannerArtifactLayout(artifactRoot) {
  const plannerRoot = join(artifactRoot, 'planner');
  const logicalDir = join(plannerRoot, 'logical');
  const milestoneDir = join(plannerRoot, 'milestones');
  mkdirSync(logicalDir, { recursive: true });
  mkdirSync(milestoneDir, { recursive: true });
  return { plannerRoot, logicalDir, milestoneDir };
}

function normalizeLogicalNodes(rawNodes) {
  if (rawNodes.length === 0) fail('logical', 'requires at least one logical artifact');
  const byId = new Map();
  const nodes = rawNodes.map((item, index) => {
    const path = `logical:${item.id ?? index}`;
    const allowed = new Set(['id', 'title', 'summary', 'parentId']);
    for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unexpected property');
    assertId(item.id, `${path}.id`);
    assertString(item.title, `${path}.title`);
    assertString(item.summary, `${path}.summary`);
    if (item.parentId !== null) assertId(item.parentId, `${path}.parentId`);
    if (byId.has(item.id)) fail(`${path}.id`, `duplicate logical id ${item.id}`);
    const node = { id: item.id, title: item.title, summary: item.summary, parentId: item.parentId };
    byId.set(node.id, node);
    return node;
  });

  for (const node of nodes) {
    if (node.parentId === null) continue;
    if (!byId.has(node.parentId)) fail(`logical:${node.id}.parentId`, `unknown logical parent ${node.parentId}`);
    if (node.parentId === node.id) fail(`logical:${node.id}.parentId`, 'must not reference itself');
  }
  assertAcyclic(nodes.map(node => node.id), id => byId.get(id)?.parentId ? [byId.get(id).parentId] : [], 'logical', 'logical tree');
  const roots = nodes.filter(node => node.parentId === null);
  if (roots.length !== 1) fail('logical', `must contain exactly one root; found ${roots.length}`);
  return { nodes, byId, root: roots[0] };
}

function normalizeTask(item, milestoneId, logicalById, taskIds) {
  const path = `milestone:${milestoneId}.task:${item?.id ?? '?'}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail(path, 'must be an object');
  const allowed = new Set(['id', 'title', 'intent', 'dependsOn', 'logicalRefs', 'acceptanceCriteria', 'testStrategy', 'history']);
  for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unexpected property');
  assertId(item.id, `${path}.id`);
  if (taskIds.has(item.id)) fail(`${path}.id`, `duplicate task id ${item.id}`);
  taskIds.add(item.id);
  assertString(item.title, `${path}.title`);
  assertString(item.intent, `${path}.intent`);
  assertStringArray(item.dependsOn, `${path}.dependsOn`);
  assertStringArray(item.logicalRefs, `${path}.logicalRefs`, { nonEmpty: true });
  for (const ref of item.logicalRefs) if (!logicalById.has(ref)) fail(`${path}.logicalRefs`, `unknown logical ref ${ref}`);
  assertStringArray(item.acceptanceCriteria, `${path}.acceptanceCriteria`, { nonEmpty: true });
  assertString(item.testStrategy, `${path}.testStrategy`);
  if (item.history != null && !Array.isArray(item.history)) fail(`${path}.history`, 'must be an array when present');
  return {
    id: item.id,
    title: item.title,
    intent: item.intent,
    dependsOn: [...item.dependsOn],
    logicalRefs: [...item.logicalRefs],
    milestoneId,
    acceptanceCriteria: [...item.acceptanceCriteria],
    testStrategy: item.testStrategy,
    history: structuredClone(item.history ?? []),
  };
}

function normalizeMilestones(rawMilestones, logicalById) {
  if (rawMilestones.length === 0) fail('milestones', 'requires at least one milestone artifact');
  const byId = new Map();
  const taskIds = new Set();
  const milestones = rawMilestones.map((item, index) => {
    const path = `milestone:${item.id ?? index}`;
    const allowed = new Set(['id', 'title', 'goal', 'parentId', 'dependsOn', 'logicalRefs', 'acceptanceCriteria', 'testStrategy', 'tasks']);
    for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unexpected property');
    assertId(item.id, `${path}.id`);
    if (byId.has(item.id)) fail(`${path}.id`, `duplicate milestone id ${item.id}`);
    assertString(item.title, `${path}.title`);
    assertString(item.goal, `${path}.goal`);
    if (item.parentId !== null) assertId(item.parentId, `${path}.parentId`);
    assertStringArray(item.dependsOn, `${path}.dependsOn`);
    assertStringArray(item.logicalRefs, `${path}.logicalRefs`, { nonEmpty: true });
    for (const ref of item.logicalRefs) if (!logicalById.has(ref)) fail(`${path}.logicalRefs`, `unknown logical ref ${ref}`);
    assertStringArray(item.acceptanceCriteria, `${path}.acceptanceCriteria`, { nonEmpty: true });
    assertString(item.testStrategy, `${path}.testStrategy`);
    if (!Array.isArray(item.tasks) || item.tasks.length === 0) fail(`${path}.tasks`, 'must contain at least one execution/integration task');
    const milestone = {
      id: item.id,
      title: item.title,
      goal: item.goal,
      parentId: item.parentId,
      dependsOn: [...item.dependsOn],
      logicalRefs: [...item.logicalRefs],
      acceptanceCriteria: [...item.acceptanceCriteria],
      testStrategy: item.testStrategy,
      tasks: [],
    };
    byId.set(milestone.id, milestone);
    milestone.tasks = item.tasks.map(task => normalizeTask(task, milestone.id, logicalById, taskIds));
    return milestone;
  });

  for (const milestone of milestones) {
    if (milestone.parentId !== null) {
      if (!byId.has(milestone.parentId)) fail(`milestone:${milestone.id}.parentId`, `unknown milestone parent ${milestone.parentId}`);
      if (milestone.parentId === milestone.id) fail(`milestone:${milestone.id}.parentId`, 'must not reference itself');
    }
    for (const depId of milestone.dependsOn) {
      if (!byId.has(depId)) fail(`milestone:${milestone.id}.dependsOn`, `unknown milestone dependency ${depId}`);
      if (depId === milestone.id) fail(`milestone:${milestone.id}.dependsOn`, 'must not depend on itself');
    }
  }

  assertAcyclic(milestones.map(m => m.id), id => byId.get(id)?.parentId ? [byId.get(id).parentId] : [], 'milestones', 'milestone tree');
  assertAcyclic(milestones.map(m => m.id), id => byId.get(id)?.dependsOn ?? [], 'milestones', 'milestone dependencies');

  const childrenById = new Map(milestones.map(m => [m.id, []]));
  for (const milestone of milestones) {
    if (milestone.parentId) childrenById.get(milestone.parentId).push(milestone.id);
  }

  return { milestones, byId, childrenById };
}

function dependencyClosure(milestonesById, childrenById, milestoneId) {
  const seen = new Set();
  const stack = [
    ...(milestonesById.get(milestoneId)?.dependsOn ?? []),
    ...(childrenById.get(milestoneId) ?? []),
  ];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(
      ...(milestonesById.get(id)?.dependsOn ?? []),
      ...(childrenById.get(id) ?? [])
    );
  }
  return seen;
}

export function validatePlannerArtifactPlan(plan) {
  if (!plan || plan.version !== 3) fail('$', 'artifact plan version must equal 3');
  const logical = normalizeLogicalNodes(plan.logicalNodes ?? []);
  const milestoneState = normalizeMilestones(plan.milestones ?? [], logical.byId);
  const tasks = milestoneState.milestones.flatMap(m => m.tasks.map(task => structuredClone(task)));
  const taskById = new Map(tasks.map(task => [task.id, task]));

  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      const dep = taskById.get(depId);
      if (!dep) fail(`task:${task.id}.dependsOn`, `unknown task dependency ${depId}`);
      if (depId === task.id) fail(`task:${task.id}.dependsOn`, 'must not depend on itself');
      if (dep.milestoneId !== task.milestoneId) {
        const allowed = dependencyClosure(milestoneState.byId, milestoneState.childrenById, task.milestoneId);
        if (!allowed.has(dep.milestoneId)) {
          fail(`task:${task.id}.dependsOn`, `cross-milestone dependency ${depId} is outside milestone prerequisites for ${task.milestoneId}`);
        }
      }
    }
  }

  // Milestone hierarchy is execution structure: every task owned by a parent
  // milestone waits for the integration tasks of each direct child milestone.
  // Explicit milestone dependsOn behaves the same way. Logical hierarchy never
  // contributes execution edges.
  for (const milestone of milestoneState.milestones) {
    const prerequisiteMilestoneIds = [
      ...(milestoneState.childrenById.get(milestone.id) ?? []),
      ...milestone.dependsOn,
    ];
    const derived = prerequisiteMilestoneIds.flatMap(id => milestoneState.byId.get(id).tasks.map(task => task.id));
    for (const task of milestone.tasks) {
      task.dependsOn = [...new Set([...task.dependsOn, ...derived])];
    }
  }

  try {
    buildExecutionGraph(tasks);
  } catch (error) {
    fail('tasks', error?.message ?? String(error));
  }

  return {
    ok: true,
    plan: {
      version: 3,
      projectSummary: logical.root.summary,
      logicalRootId: logical.root.id,
      logicalNodes: structuredClone(logical.nodes),
      milestones: milestoneState.milestones.map(({ tasks: _tasks, ...milestone }) => structuredClone(milestone)),
      tasks,
    },
  };
}

export function loadPlannerArtifactPlan(artifactRoot) {
  if (!artifactRoot) return null;
  const { logicalDir, milestoneDir } = ensurePlannerArtifactLayout(artifactRoot);
  const logicalNodes = scanFlatJsonDirectory(logicalDir, 'logical');
  const rawMilestones = scanFlatJsonDirectory(milestoneDir, 'milestones');
  if (logicalNodes.length === 0 && rawMilestones.length === 0) return null;
  return {
    version: 3,
    logicalNodes,
    milestones: rawMilestones,
  };
}

export function plannerArtifactInstructions(artifactRoot) {
  const { logicalDir, milestoneDir } = ensurePlannerArtifactLayout(artifactRoot);
  return [
    'PLANNER ARTIFACT TRANSPORT',
    'Do NOT return or write one monolithic project-plan JSON.',
    'The filesystem is the artifact registry; there is no manifest.',
    `Write logical artifacts as flat JSON files in: ${logicalDir}`,
    `Write milestone artifacts as flat JSON files in: ${milestoneDir}`,
    'Use exactly <id>.json. IDs may contain dots for hierarchy (for example battle.combat or M1.1.2) but filenames/directories do not define parentage.',
    'Do not create subdirectories. parentId is the only durable parent relation. Do not store children arrays; children are derived by scanning parentId.',
    'Logical artifacts describe WHAT the product is and never create execution dependencies.',
    'Logical artifact shape: {"id":"battle.combat","title":"Combat","summary":"...","parentId":"battle"}',
    'Milestone artifacts describe HOW work executes. A parent milestone implicitly executes after all direct child milestones and should own integration/E2E/acceptance work.',
    'Milestone dependsOn is only for extra prerequisite milestones outside parent-child ordering.',
    'Milestone artifact shape: {"id":"M1.1","title":"...","goal":"...","parentId":"M1","dependsOn":[],"logicalRefs":["battle"],"acceptanceCriteria":["..."],"testStrategy":"...","tasks":[...]}',
    'Task shape inside its owning milestone: {"id":"...","title":"...","intent":"...","dependsOn":[],"logicalRefs":["..."],"acceptanceCriteria":["..."],"testStrategy":"...","history":[]}',
    'Every milestone, including non-leaf milestones, must own at least one bounded execution/integration task so its acceptance boundary is executable.',
    'TL chooses decomposition depth. Split large logical areas and large milestones recursively until each artifact is bounded enough to generate and review reliably.',
    'When repairing or adding scope, edit only affected artifacts; do not rewrite unrelated files.',
    'After all required files are successfully written, return only a small JSON result; never echo the full artifacts in the final reply.',
  ].join('\n');
}
