import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const INTERFACE_KINDS = new Set(['executor', 'provider']);
const VISIBILITIES = new Set(['internal', 'exported']);
const DECOMPOSITION_KINDS = new Set(['leaf', 'expand']);

function fail(message) {
  const error = new Error(message);
  error.code = 'INTERFACE_CONTRACT_INVALID';
  throw error;
}

function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => JSON.parse(readFileSync(join(dir, entry.name), 'utf8')));
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function ensureInterfaceArtifactLayout(artifactRoot) {
  const plannerRoot = join(artifactRoot, 'planner');
  const interfaceRoot = join(plannerRoot, 'interfaces');
  const featureDir = join(interfaceRoot, 'features');
  const milestoneDir = join(interfaceRoot, 'milestones');
  const frozenExportsPath = join(interfaceRoot, 'frozen-exports.json');
  const activeFrontierPath = join(interfaceRoot, 'active-frontier.json');
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(milestoneDir, { recursive: true });
  return { plannerRoot, interfaceRoot, featureDir, milestoneDir, frozenExportsPath, activeFrontierPath };
}

function hierarchy(items, label) {
  const byId = new Map();
  for (const item of items) {
    if (!item?.id || typeof item.id !== 'string') fail(`${label}: item requires id`);
    if (byId.has(item.id)) fail(`${label}: duplicate id ${item.id}`);
    byId.set(item.id, item);
  }
  for (const item of items) {
    if (item.parentId != null && !byId.has(item.parentId)) {
      fail(`${label}:${item.id}: unknown parent ${item.parentId}`);
    }
  }

  const depthById = new Map();
  function depth(id, stack = new Set()) {
    if (depthById.has(id)) return depthById.get(id);
    if (stack.has(id)) fail(`${label}: cycle at ${id}`);
    stack.add(id);
    const item = byId.get(id);
    const value = item.parentId == null ? 0 : depth(item.parentId, stack) + 1;
    stack.delete(id);
    depthById.set(id, value);
    return value;
  }

  const childrenById = new Map(items.map(item => [item.id, []]));
  for (const item of items) {
    depth(item.id);
    if (item.parentId != null) childrenById.get(item.parentId).push(item.id);
  }
  for (const children of childrenById.values()) children.sort();

  const roots = items.filter(item => item.parentId == null);
  if (items.length > 0 && roots.length !== 1) fail(`${label}: expected exactly one root; found ${roots.length}`);
  return { byId, depthById, childrenById, root: roots[0] ?? null };
}

export function loadPlannerHierarchy(artifactRoot, nodeType) {
  const plannerRoot = join(artifactRoot, 'planner');
  const dir = nodeType === 'feature'
    ? join(plannerRoot, 'logical')
    : join(plannerRoot, 'milestones');
  const items = readJsonDir(dir);
  return { items, ...hierarchy(items, nodeType) };
}

function normalizeContract(raw, expectedNodeType) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('contract must be object');
  const allowed = new Set([
    'version', 'nodeId', 'nodeType', 'decomposition',
    'interfaces', 'imports', 'integrationScenarios', 'featureUses', 'bindings',
    'featureTasks', 'taskLinks', 'integrationTasks',
  ]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail(`${raw.nodeId ?? '?'}: unexpected property ${key}`);
  if (raw.version !== 1) fail(`${raw.nodeId ?? '?'}: version must be 1`);
  if (raw.nodeType !== expectedNodeType) fail(`${raw.nodeId ?? '?'}: nodeType must be ${expectedNodeType}`);
  if (typeof raw.nodeId !== 'string' || !raw.nodeId) fail('contract requires nodeId');

  if (!raw.decomposition || typeof raw.decomposition !== 'object' || Array.isArray(raw.decomposition)) {
    fail(`${raw.nodeId}: decomposition required`);
  }
  if (!DECOMPOSITION_KINDS.has(raw.decomposition.kind)) {
    fail(`${raw.nodeId}: decomposition.kind must be leaf|expand`);
  }
  if (typeof raw.decomposition.reason !== 'string' || !raw.decomposition.reason.trim()) {
    fail(`${raw.nodeId}: decomposition.reason required`);
  }

  if (!Array.isArray(raw.interfaces)) fail(`${raw.nodeId}: interfaces must be array`);
  if (!Array.isArray(raw.imports)) fail(`${raw.nodeId}: imports must be array`);
  if (!Array.isArray(raw.integrationScenarios)) fail(`${raw.nodeId}: integrationScenarios must be array`);
  const featureUsesRaw = raw.featureUses ?? [];
  const bindingsRaw = raw.bindings ?? [];
  const featureTasksRaw = raw.featureTasks ?? [];
  const taskLinksRaw = raw.taskLinks ?? [];
  const integrationTasksRaw = raw.integrationTasks ?? [];
  if (!Array.isArray(featureUsesRaw)) fail(`${raw.nodeId}: featureUses must be array`);
  if (!Array.isArray(bindingsRaw)) fail(`${raw.nodeId}: bindings must be array`);
  if (!Array.isArray(featureTasksRaw)) fail(`${raw.nodeId}: featureTasks must be array`);
  if (!Array.isArray(taskLinksRaw)) fail(`${raw.nodeId}: taskLinks must be array`);
  if (!Array.isArray(integrationTasksRaw)) fail(`${raw.nodeId}: integrationTasks must be array`);
  if (expectedNodeType === 'feature' && (featureUsesRaw.length || taskLinksRaw.length || integrationTasksRaw.length)) {
    fail(`${raw.nodeId}: feature contracts cannot own milestone featureUses/taskLinks/integrationTasks`);
  }
  if (expectedNodeType === 'milestone' && featureTasksRaw.length) {
    fail(`${raw.nodeId}: milestone contracts cannot define canonical featureTasks`);
  }

  const interfaceIds = new Set();
  const interfaces = raw.interfaces.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${raw.nodeId}.interfaces[${index}] invalid`);
    const keys = new Set(['id', 'kind', 'visibility', 'contract', 'verificationSketch', 'realization', 'verification']);
    for (const key of Object.keys(entry)) if (!keys.has(key)) fail(`${raw.nodeId}.interfaces[${index}].${key} unexpected`);
    if (typeof entry.id !== 'string' || !entry.id) fail(`${raw.nodeId}.interfaces[${index}].id required`);
    if (interfaceIds.has(entry.id)) fail(`${raw.nodeId}: duplicate interface ${entry.id}`);
    interfaceIds.add(entry.id);
    if (!INTERFACE_KINDS.has(entry.kind)) fail(`${raw.nodeId}.${entry.id}: kind must be executor|provider`);
    if (!VISIBILITIES.has(entry.visibility)) fail(`${raw.nodeId}.${entry.id}: invalid visibility ${entry.visibility}`);

    const normalizeTextList = (value, fieldPath) => {
      const values = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(values)) fail(`${fieldPath}: must be string|string[]`);
      const normalized = values.map((item, itemIndex) => {
        if (typeof item !== 'string' || !item.trim()) fail(`${fieldPath}[${itemIndex}]: non-empty string required`);
        return item.trim();
      });
      return normalized;
    };

    if (!entry.contract || typeof entry.contract !== 'object' || Array.isArray(entry.contract)) {
      fail(`${raw.nodeId}.${entry.id}: contract must be object`);
    }
    let normalizedSemanticContract;
    if (entry.kind === 'executor') {
      const allowed = new Set(['input', 'output', 'sideEffects']);
      for (const key of Object.keys(entry.contract)) {
        if (!allowed.has(key)) fail(`${raw.nodeId}.${entry.id}.contract.${key}: unexpected property`);
      }
      for (const key of ['input', 'output', 'sideEffects']) {
        if (!(key in entry.contract)) fail(`${raw.nodeId}.${entry.id}.contract.${key}: required`);
      }
      normalizedSemanticContract = {
        input: normalizeTextList(entry.contract.input, `${raw.nodeId}.${entry.id}.contract.input`),
        output: normalizeTextList(entry.contract.output, `${raw.nodeId}.${entry.id}.contract.output`),
        sideEffects: normalizeTextList(entry.contract.sideEffects, `${raw.nodeId}.${entry.id}.contract.sideEffects`),
      };
    } else {
      const allowed = new Set(['input', 'produces']);
      for (const key of Object.keys(entry.contract)) {
        if (!allowed.has(key)) fail(`${raw.nodeId}.${entry.id}.contract.${key}: unexpected property`);
      }
      if (!('input' in entry.contract)) fail(`${raw.nodeId}.${entry.id}.contract.input: required`);
      const produces = entry.contract.produces;
      if (!produces || typeof produces !== 'object' || Array.isArray(produces)) {
        fail(`${raw.nodeId}.${entry.id}.contract.produces: required object`);
      }
      const allowedProduces = new Set(['thing', 'input', 'output', 'sideEffects']);
      for (const key of Object.keys(produces)) {
        if (!allowedProduces.has(key)) fail(`${raw.nodeId}.${entry.id}.contract.produces.${key}: unexpected property`);
      }
      if (typeof produces.thing !== 'string' || !produces.thing.trim()) {
        fail(`${raw.nodeId}.${entry.id}.contract.produces.thing: non-empty string required`);
      }
      for (const key of ['input', 'output', 'sideEffects']) {
        if (!(key in produces)) fail(`${raw.nodeId}.${entry.id}.contract.produces.${key}: required`);
      }
      normalizedSemanticContract = {
        input: normalizeTextList(entry.contract.input, `${raw.nodeId}.${entry.id}.contract.input`),
        produces: {
          thing: produces.thing.trim(),
          input: normalizeTextList(produces.input, `${raw.nodeId}.${entry.id}.contract.produces.input`),
          output: normalizeTextList(produces.output, `${raw.nodeId}.${entry.id}.contract.produces.output`),
          sideEffects: normalizeTextList(produces.sideEffects, `${raw.nodeId}.${entry.id}.contract.produces.sideEffects`),
        },
      };
    }
    if (entry.verificationSketch != null && (typeof entry.verificationSketch !== 'string' || !entry.verificationSketch.trim())) {
      fail(`${raw.nodeId}.${entry.id}.verificationSketch: must be a non-empty string when present`);
    }

    const normalizeAnchor = (anchor, anchorPath) => {
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) fail(`${anchorPath}: must be object`);
      const allowed = new Set(['kind', 'file', 'symbol', 'startLine', 'endLine', 'role', 'boundAtCommit', 'fileHash']);
      for (const key of Object.keys(anchor)) if (!allowed.has(key)) fail(`${anchorPath}.${key}: unexpected property`);
      if (!['symbol', 'range'].includes(anchor.kind)) fail(`${anchorPath}.kind: must be symbol|range`);
      if (typeof anchor.file !== 'string' || !anchor.file.trim()) fail(`${anchorPath}.file: required`);
      if (anchor.kind === 'symbol' && (typeof anchor.symbol !== 'string' || !anchor.symbol.trim())) {
        fail(`${anchorPath}.symbol: required for symbol anchor`);
      }
      if (anchor.kind === 'range') {
        if (!Number.isInteger(anchor.startLine) || anchor.startLine < 1) fail(`${anchorPath}.startLine: positive integer required`);
        if (!Number.isInteger(anchor.endLine) || anchor.endLine < anchor.startLine) fail(`${anchorPath}.endLine: must be >= startLine`);
      }
      return structuredClone(anchor);
    };

    const realization = entry.realization ?? [];
    const verification = entry.verification ?? [];
    if (!Array.isArray(realization)) fail(`${raw.nodeId}.${entry.id}.realization: must be array`);
    if (!Array.isArray(verification)) fail(`${raw.nodeId}.${entry.id}.verification: must be array`);
    return {
      id: entry.id,
      kind: entry.kind,
      visibility: entry.visibility,
      contract: normalizedSemanticContract,
      ...(entry.verificationSketch ? { verificationSketch: entry.verificationSketch.trim() } : {}),
      realization: realization.map((anchor, anchorIndex) =>
        normalizeAnchor(anchor, `${raw.nodeId}.${entry.id}.realization[${anchorIndex}]`)
      ),
      verification: verification.map((anchor, anchorIndex) =>
        normalizeAnchor(anchor, `${raw.nodeId}.${entry.id}.verification[${anchorIndex}]`)
      ),
    };
  });

  const imports = raw.imports.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${raw.nodeId}.imports[${index}] invalid`);
    const keys = new Set(['fromNodeId', 'interfaceId', 'purpose']);
    for (const key of Object.keys(entry)) if (!keys.has(key)) fail(`${raw.nodeId}.imports[${index}].${key} unexpected`);
    for (const key of ['fromNodeId', 'interfaceId', 'purpose']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) fail(`${raw.nodeId}.imports[${index}].${key} required`);
    }
    return structuredClone(entry);
  });

  const integrationScenarios = raw.integrationScenarios.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${raw.nodeId}.integrationScenarios[${index}] invalid`);
    const keys = new Set(['id', 'description', 'uses']);
    for (const key of Object.keys(entry)) if (!keys.has(key)) fail(`${raw.nodeId}.integrationScenarios[${index}].${key} unexpected`);
    if (typeof entry.id !== 'string' || !entry.id) fail(`${raw.nodeId}.integrationScenarios[${index}].id required`);
    if (typeof entry.description !== 'string' || !entry.description.trim()) fail(`${raw.nodeId}.integrationScenarios[${index}].description required`);
    if (!Array.isArray(entry.uses)) fail(`${raw.nodeId}.integrationScenarios[${index}].uses must be array`);
    return {
      id: entry.id,
      description: entry.description,
      uses: entry.uses.map((use, useIndex) => {
        if (!use || typeof use !== 'object' || Array.isArray(use)) fail(`${raw.nodeId}.integrationScenarios[${index}].uses[${useIndex}] invalid`);
        if (typeof use.nodeId !== 'string' || !use.nodeId) fail('scenario use requires nodeId');
        if (typeof use.interfaceId !== 'string' || !use.interfaceId) fail('scenario use requires interfaceId');
        const graph = use.graph ?? expectedNodeType;
        if (!['feature', 'milestone'].includes(graph)) fail('scenario use graph must be feature|milestone');
        if (expectedNodeType === 'feature' && graph !== 'feature') {
          fail(`${raw.nodeId}: feature scenario cannot consume milestone interfaces`);
        }
        return { graph, nodeId: use.nodeId, interfaceId: use.interfaceId };
      }),
    };
  });

  function normalizeAnchor(anchor, path) {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) fail(`${path}: anchor must be object`);
    const allowed = new Set([
      'kind', 'file', 'symbol', 'startLine', 'startCharacter', 'endLine', 'endCharacter',
      'provider', 'fileHash', 'observedCommit', 'status',
    ]);
    for (const key of Object.keys(anchor)) if (!allowed.has(key)) fail(`${path}.${key}: unexpected property`);
    if (!['symbol', 'range'].includes(anchor.kind)) fail(`${path}.kind must be symbol|range`);
    if (typeof anchor.file !== 'string' || !anchor.file.trim()) fail(`${path}.file required`);
    if (anchor.kind === 'symbol' && (typeof anchor.symbol !== 'string' || !anchor.symbol.trim())) {
      fail(`${path}.symbol required for symbol anchor`);
    }
    if (anchor.startLine != null && (!Number.isInteger(anchor.startLine) || anchor.startLine < 1)) {
      fail(`${path}.startLine must be positive integer`);
    }
    if (anchor.endLine != null && (!Number.isInteger(anchor.endLine) || anchor.endLine < 1)) {
      fail(`${path}.endLine must be positive integer`);
    }
    if (anchor.startLine != null && anchor.endLine != null && anchor.endLine < anchor.startLine) {
      fail(`${path}: endLine must be >= startLine`);
    }
    if (anchor.status != null && !['VALID', 'DIRTY', 'BROKEN'].includes(anchor.status)) {
      fail(`${path}.status must be VALID|DIRTY|BROKEN`);
    }
    return structuredClone(anchor);
  }

  const bindingsSeen = new Set();
  const bindings = bindingsRaw.map((binding, index) => {
    const path = `${raw.nodeId}.bindings[${index}]`;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail(`${path}: binding must be object`);
    const allowed = new Set(['interfaceId', 'realizationAnchors', 'verificationAnchors']);
    for (const key of Object.keys(binding)) if (!allowed.has(key)) fail(`${path}.${key}: unexpected property`);
    if (typeof binding.interfaceId !== 'string' || !binding.interfaceId.trim()) fail(`${path}.interfaceId required`);
    if (!interfaceIds.has(binding.interfaceId)) fail(`${path}: unknown interface ${binding.interfaceId}`);
    if (bindingsSeen.has(binding.interfaceId)) fail(`${raw.nodeId}: duplicate binding for interface ${binding.interfaceId}`);
    bindingsSeen.add(binding.interfaceId);
    const realizationAnchors = binding.realizationAnchors ?? [];
    const verificationAnchors = binding.verificationAnchors ?? [];
    if (!Array.isArray(realizationAnchors)) fail(`${path}.realizationAnchors must be array`);
    if (!Array.isArray(verificationAnchors)) fail(`${path}.verificationAnchors must be array`);
    return {
      interfaceId: binding.interfaceId,
      realizationAnchors: realizationAnchors.map((anchor, i) => normalizeAnchor(anchor, `${path}.realizationAnchors[${i}]`)),
      verificationAnchors: verificationAnchors.map((anchor, i) => normalizeAnchor(anchor, `${path}.verificationAnchors[${i}]`)),
    };
  });

  const featureUses = featureUsesRaw.map((use, index) => {
    const path = `${raw.nodeId}.featureUses[${index}]`;
    if (!use || typeof use !== 'object' || Array.isArray(use)) fail(`${path}: must be object`);
    const allowed = new Set(['featureId', 'interfaceId', 'purpose']);
    for (const key of Object.keys(use)) if (!allowed.has(key)) fail(`${path}.${key}: unexpected property`);
    for (const key of ['featureId', 'interfaceId', 'purpose']) {
      if (typeof use[key] !== 'string' || !use[key].trim()) fail(`${path}.${key}: required`);
    }
    return structuredClone(use);
  });

  function normalizeBaseTask(task, path) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) fail(`${path}: task must be object`);
    const allowed = new Set(['id', 'title', 'intent', 'acceptanceCriteria', 'testStrategy', 'verification', 'interfaceIds']);
    for (const key of Object.keys(task)) if (!allowed.has(key)) fail(`${path}.${key}: unexpected property`);
    for (const key of ['id', 'title', 'intent', 'testStrategy']) {
      if (typeof task[key] !== 'string' || !task[key].trim()) fail(`${path}.${key}: required`);
    }
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      fail(`${path}.acceptanceCriteria: non-empty array required`);
    }
    if (task.verification != null && !Array.isArray(task.verification)) fail(`${path}.verification: must be array`);
    if (task.interfaceIds != null && !Array.isArray(task.interfaceIds)) fail(`${path}.interfaceIds: must be array`);
    for (const interfaceId of task.interfaceIds ?? []) {
      if (typeof interfaceId !== 'string' || !interfaceIds.has(interfaceId)) {
        fail(`${path}.interfaceIds contains unknown interface ${interfaceId}`);
      }
    }
    return {
      id: task.id,
      title: task.title,
      intent: task.intent,
      acceptanceCriteria: [...task.acceptanceCriteria],
      testStrategy: task.testStrategy,
      verification: structuredClone(task.verification ?? []),
      interfaceIds: [...(task.interfaceIds ?? [])],
    };
  }

  const featureTasks = featureTasksRaw.map((task, index) =>
    normalizeBaseTask(task, `${raw.nodeId}.featureTasks[${index}]`)
  );

  const integrationTasks = integrationTasksRaw.map((task, index) =>
    normalizeBaseTask(task, `${raw.nodeId}.integrationTasks[${index}]`)
  );

  const taskLinks = taskLinksRaw.map((link, index) => {
    const path = `${raw.nodeId}.taskLinks[${index}]`;
    if (!link || typeof link !== 'object' || Array.isArray(link)) fail(`${path}: must be object`);
    const allowed = new Set(['taskId', 'addDependsOn', 'addVerification']);
    for (const key of Object.keys(link)) if (!allowed.has(key)) fail(`${path}.${key}: unexpected property`);
    if (typeof link.taskId !== 'string' || !link.taskId.trim()) fail(`${path}.taskId: required`);
    if (link.addDependsOn != null && !Array.isArray(link.addDependsOn)) fail(`${path}.addDependsOn: must be array`);
    if (link.addVerification != null && !Array.isArray(link.addVerification)) fail(`${path}.addVerification: must be array`);
    return {
      taskId: link.taskId,
      addDependsOn: [...(link.addDependsOn ?? [])],
      addVerification: structuredClone(link.addVerification ?? []),
    };
  });

  return {
    version: 1,
    nodeId: raw.nodeId,
    nodeType: raw.nodeType,
    decomposition: structuredClone(raw.decomposition),
    interfaces,
    imports,
    integrationScenarios,
    featureUses,
    bindings,
    featureTasks,
    taskLinks,
    integrationTasks,
  };
}

export function loadBoundaryContracts(artifactRoot, nodeType) {
  const { featureDir, milestoneDir } = ensureInterfaceArtifactLayout(artifactRoot);
  const dir = nodeType === 'feature' ? featureDir : milestoneDir;
  const contracts = readJsonDir(dir).map(raw => normalizeContract(raw, nodeType));
  return new Map(contracts.map(contract => [contract.nodeId, contract]));
}

function exportedInterfaces(contract) {
  return contract.interfaces
    .filter(entry => entry.visibility === 'exported')
    .map(entry => ({
      id: entry.id,
      kind: entry.kind,
      visibility: entry.visibility,
      contract: structuredClone(entry.contract),
    }));
}

function loadFrozenExports(artifactRoot) {
  const { frozenExportsPath } = ensureInterfaceArtifactLayout(artifactRoot);
  if (!existsSync(frozenExportsPath)) return {};
  return JSON.parse(readFileSync(frozenExportsPath, 'utf8'));
}

function freezeAndValidateExports(artifactRoot, nodeType, contracts) {
  const { frozenExportsPath } = ensureInterfaceArtifactLayout(artifactRoot);
  const registry = loadFrozenExports(artifactRoot);
  let changed = false;
  for (const [nodeId, contract] of contracts) {
    const key = `${nodeType}:${nodeId}`;
    const current = exportedInterfaces(contract);
    if (registry[key] == null) {
      registry[key] = current;
      changed = true;
      continue;
    }
    if (stableJson(registry[key]) !== stableJson(current)) {
      fail(`${key}: exported interface changed after it was exposed to its parent`);
    }
  }
  if (changed) writeFileSync(frozenExportsPath, JSON.stringify(registry, null, 2) + '\n');
}

export function validateBoundaryContracts(artifactRoot, nodeType, { allowFrontier = true } = {}) {
  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  const contracts = loadBoundaryContracts(artifactRoot, nodeType);

  if (tree.items.length === 0) return { ok: true, count: 0, complete: false };
  if (contracts.size !== tree.items.length) {
    fail(`${nodeType}: every planned node must have exactly one boundary contract`);
  }

  // Validate already-exposed parent-facing surfaces before checking current
  // parent imports so a contract mutation fails at the true source.
  freezeAndValidateExports(artifactRoot, nodeType, contracts);

  const featureContracts = nodeType === 'milestone'
    ? loadBoundaryContracts(artifactRoot, 'feature')
    : null;

  for (const item of tree.items) {
    const contract = contracts.get(item.id);
    if (!contract) fail(`${nodeType}:${item.id}: missing boundary contract`);
    const children = tree.childrenById.get(item.id) ?? [];

    if (contract.decomposition.kind === 'leaf' && children.length > 0) {
      fail(`${nodeType}:${item.id}: leaf contract cannot have children`);
    }
    if (!allowFrontier && contract.decomposition.kind === 'expand' && children.length === 0) {
      fail(`${nodeType}:${item.id}: expansion still pending`);
    }

    const directChildren = new Set(children);
    for (const imported of contract.imports) {
      if (!directChildren.has(imported.fromNodeId)) {
        fail(`${nodeType}:${item.id}: import ${imported.fromNodeId}/${imported.interfaceId} is not from a direct child`);
      }
      const child = contracts.get(imported.fromNodeId);
      const exposed = child?.interfaces.find(entry =>
        entry.id === imported.interfaceId && entry.visibility === 'exported'
      );
      if (!exposed) {
        fail(`${nodeType}:${item.id}: child interface ${imported.fromNodeId}/${imported.interfaceId} is not exported`);
      }
    }

    if (nodeType === 'milestone') {
      for (const use of contract.featureUses ?? []) {
        const feature = featureContracts.get(use.featureId);
        const exposed = feature?.interfaces.find(entry =>
          entry.id === use.interfaceId && entry.visibility === 'exported'
        );
        if (!exposed) {
          fail(`milestone:${item.id}: feature interface ${use.featureId}/${use.interfaceId} is not exported`);
        }
      }
    }

    const available = new Set([
      ...contract.interfaces.map(entry => `${nodeType}:${item.id}:${entry.id}`),
      ...contract.imports.map(entry => `${nodeType}:${entry.fromNodeId}:${entry.interfaceId}`),
      ...(nodeType === 'milestone'
        ? (contract.featureUses ?? []).map(use => `feature:${use.featureId}:${use.interfaceId}`)
        : []),
    ]);
    for (const scenario of contract.integrationScenarios) {
      for (const use of scenario.uses) {
        const key = `${use.graph}:${use.nodeId}:${use.interfaceId}`;
        if (!available.has(key)) {
          fail(`${nodeType}:${item.id}: scenario ${scenario.id} uses unavailable interface ${use.graph}:${use.nodeId}/${use.interfaceId}`);
        }
      }
    }
  }

  for (const nodeId of contracts.keys()) {
    if (!tree.byId.has(nodeId)) fail(`${nodeType}: orphan boundary contract ${nodeId}`);
  }

  const frontier = nextBoundaryFrontier(artifactRoot, nodeType);
  return { ok: true, count: contracts.size, complete: frontier == null };
}

export function nextBoundaryFrontier(artifactRoot, nodeType) {
  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  if (tree.items.length === 0) {
    return {
      nodeType,
      bootstrap: true,
      node: null,
      directChildren: [],
      parent: null,
    };
  }

  const contracts = loadBoundaryContracts(artifactRoot, nodeType);
  const ordered = [...tree.items].sort((a, b) =>
    tree.depthById.get(a.id) - tree.depthById.get(b.id)
    || a.id.localeCompare(b.id)
  );

  for (const node of ordered) {
    const contract = contracts.get(node.id);
    const children = tree.childrenById.get(node.id) ?? [];
    if (!contract) {
      if (node.id === tree.root?.id) {
        return {
          nodeType,
          bootstrap: true,
          contractBootstrap: true,
          node: structuredClone(node),
          directChildren: children.map(childId => structuredClone(tree.byId.get(childId))),
          parent: null,
        };
      }
      return {
        nodeType,
        bootstrap: false,
        contractBootstrap: true,
        node: structuredClone(node),
        contract: null,
        parent: node.parentId ? {
          node: structuredClone(tree.byId.get(node.parentId)),
          contract: structuredClone(contracts.get(node.parentId) ?? null),
        } : null,
        directChildren: children.map(childId => structuredClone(tree.byId.get(childId))),
      };
    }
    if (contract.decomposition.kind === 'expand' && children.length === 0) {
      return {
        nodeType,
        bootstrap: false,
        node: structuredClone(node),
        contract: structuredClone(contract),
        parent: node.parentId ? {
          node: structuredClone(tree.byId.get(node.parentId)),
          contract: structuredClone(contracts.get(node.parentId)),
        } : null,
        directChildren: [],
      };
    }
  }
  return null;
}

export function frontierPromptContext(artifactRoot, nodeType) {
  const frontier = nextBoundaryFrontier(artifactRoot, nodeType);
  if (frontier?.bootstrap) {
    if (frontier.contractBootstrap === true) {
      return {
        ...frontier,
        instruction: `The existing ${nodeType} root and its current direct-child hierarchy are already materialized. Do not recreate or rename them. Define the root's complete boundary contract and complete contracts for every already-present direct child. Do not create grandchildren in this round.`,
      };
    }
    return {
      nodeType,
      bootstrap: true,
      instruction: `Create the single ${nodeType} root, define its complete boundary contract, and if it needs decomposition create exactly one direct-child layer with complete child contracts.`,
    };
  }
  if (!frontier) return { nodeType, complete: true };
  if (frontier.contractBootstrap === true) {
    return {
      nodeType,
      bootstrap: false,
      contractBootstrap: true,
      current: frontier,
      instruction: `Define the missing complete boundary contract for existing ${frontier.node.id}. Preserve the existing hierarchy. If it already has direct children, define complete contracts for those children in this round and do not create grandchildren.`,
    };
  }
  return {
    nodeType,
    bootstrap: false,
    current: frontier,
    instruction: `Expand only ${frontier.node.id} by exactly one direct-child layer, or change it to leaf if further decomposition is not justified. Preserve its already-frozen exported interfaces exactly.`,
  };
}

export function frontierArtifactInstructions(artifactRoot, nodeType) {
  const { featureDir, milestoneDir } = ensureInterfaceArtifactLayout(artifactRoot);
  const contractDir = nodeType === 'feature' ? featureDir : milestoneDir;
  const nodeDir = nodeType === 'feature'
    ? join(artifactRoot, 'planner', 'logical')
    : join(artifactRoot, 'planner', 'milestones');
  return [
    `Node artifacts: ${nodeDir}`,
    `Boundary contracts: ${contractDir}`,
    'Every node present in the hierarchy must have one boundary contract.',
    'Contract shape includes decomposition, interfaces/imports/integrationScenarios plus task ownership fields.',
    'Interface primitive model is ONLY executor|provider. Do not emit legacy service/ui/journey/event/data types.',
    'Executor shape: {id,kind:"executor",visibility,contract:{input:string|string[],output:string|string[],sideEffects:string|string[]},verificationSketch?}.',
    'Provider shape: {id,kind:"provider",visibility,contract:{input:string|string[],produces:{thing:string,input:string|string[],output:string|string[],sideEffects:string|string[]}},verificationSketch?}.',
    'Use [] for semantically empty input/output/sideEffects. Provider is appropriate for UI/rendered/interactive surfaces because it produces a thing with its own interaction contract.',
    'Each interface may carry realization:[symbol|range anchors] and verification:[symbol|range anchors]. These bindings are implementation metadata and may change without changing the frozen semantic interface contract.',
    'Feature contracts may define featureTasks:[{id,title,intent,acceptanceCriteria,testStrategy,verification,interfaceIds}] DURING the feature frontier pass. interfaceIds names the exact interfaces the task implements/seals.',
    'Milestone contracts may define featureUses:[{featureId,interfaceId,purpose}] referencing exported Feature interfaces. integrationScenarios.uses can then reference them as {graph:"feature",nodeId:featureId,interfaceId}.',
    'bindings live in the same contract artifact but are runtime metadata, not part of the frozen semantic export: [{interfaceId,realizationAnchors,verificationAnchors}].',
    'Milestone contracts define integrationTasks DURING the milestone frontier pass, plus taskLinks:[{taskId,addDependsOn,addVerification}] that link existing feature tasks and only ADD dependencies/verification.',
    'Milestones have no schema field capable of overriding a linked feature task title, intent, acceptanceCriteria, or ownership.',
    'TOP-DOWN RULE: define a node boundary before looking below it.',
    'ONE-LAYER RULE: in one run create or refine only the current node and its direct children. Never create grandchildren.',
    'ENCAPSULATION RULE: a parent may depend only on direct-child exported interfaces.',
    'STABILITY RULE: once an exported interface has been exposed upward, later refinement must preserve it exactly unless a replan explicitly revises the ancestor contract.',
    'A leaf owns implementation/local correctness. A non-leaf owns integration scenarios over direct-child exports.',
    'Do not bind these contracts to concrete source files yet. Code indexing comes later.',
  ].join('\n');
}


export function validateFrontierPass(artifactRoot, nodeType, targetNodeId = null, { existingNodeParents = {} } = {}) {
  const validated = validateBoundaryContracts(artifactRoot, nodeType, { allowFrontier: true });
  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  const contracts = loadBoundaryContracts(artifactRoot, nodeType);

  const target = targetNodeId == null ? tree.root : tree.byId.get(targetNodeId);
  if (!target) {
    fail(`${nodeType}: frontier pass did not create expected target ${targetNodeId ?? 'root'}`);
  }
  const contract = contracts.get(target.id);
  if (!contract) fail(`${nodeType}:${target.id}: missing target contract after frontier pass`);

  const children = tree.childrenById.get(target.id) ?? [];
  if (contract.decomposition.kind === 'leaf') {
    if (children.length > 0) fail(`${nodeType}:${target.id}: leaf frontier pass created children`);
  } else {
    if (children.length === 0) fail(`${nodeType}:${target.id}: expand frontier pass must create direct children`);
    for (const childId of children) {
      const child = tree.byId.get(childId);
      const childContract = contracts.get(childId);
      if (!childContract) fail(`${nodeType}:${childId}: new direct child requires boundary contract`);
      const grandchildren = tree.childrenById.get(childId) ?? [];
      for (const grandchildId of grandchildren) {
        if (!Object.hasOwn(existingNodeParents, grandchildId)
          || existingNodeParents[grandchildId] !== childId) {
          fail(`${nodeType}:${target.id}: one-layer frontier pass illegally created grandchild under ${childId}`);
        }
      }
      if (child.parentId !== target.id) fail(`${nodeType}:${childId}: child parent mismatch`);
    }
  }

  return {
    ...validated,
    targetNodeId: target.id,
    targetDisposition: contract.decomposition.kind,
    childIds: [...children],
    next: nextBoundaryFrontier(artifactRoot, nodeType),
  };
}


export function beginFrontierPass(artifactRoot, nodeType) {
  const context = frontierPromptContext(artifactRoot, nodeType);
  const { activeFrontierPath } = ensureInterfaceArtifactLayout(artifactRoot);
  const state = {
    version: 1,
    nodeType,
    bootstrap: context.bootstrap === true,
    targetNodeId: context.bootstrap === true ? null : context.current?.node?.id ?? null,
    existingNodeParents: Object.fromEntries(
      loadPlannerHierarchy(artifactRoot, nodeType).items.map(node => [node.id, node.parentId ?? null]),
    ),
  };
  writeFileSync(activeFrontierPath, JSON.stringify(state, null, 2) + '\n');
  return context;
}

export function finishFrontierPass(artifactRoot, expectedNodeType, {
  expectedTargetNodeId = null,
  legacyBaselineRoot = null,
} = {}) {
  const { activeFrontierPath } = ensureInterfaceArtifactLayout(artifactRoot);
  if (!existsSync(activeFrontierPath)) fail('frontier pass has no Ariad-owned active target');
  const state = JSON.parse(readFileSync(activeFrontierPath, 'utf8'));
  if (state.nodeType !== expectedNodeType) {
    fail(`frontier target type mismatch: expected ${expectedNodeType}, found ${state.nodeType}`);
  }
  if (expectedTargetNodeId != null
    && state.targetNodeId != null
    && state.targetNodeId !== expectedTargetNodeId) {
    fail(`${expectedNodeType}: durable frontier target ${expectedTargetNodeId} disagrees with active target ${state.targetNodeId}`);
  }
  // A pre-migration archive is historical evidence, not a current-schema
  // graph. Some old milestone plans legitimately have multiple top-level
  // roots. Read their parent pointers without validating root cardinality;
  // validateFrontierPass still validates the LIVE tree strictly.
  const legacyNodeParents = legacyBaselineRoot
    ? Object.fromEntries(
        readJsonDir(join(
          legacyBaselineRoot, 'planner',
          expectedNodeType === 'feature' ? 'logical' : 'milestones',
        )).map(node => [node.id, node.parentId ?? null]),
      )
    : {};
  return validateFrontierPass(
    artifactRoot,
    expectedNodeType,
    expectedTargetNodeId ?? state.targetNodeId ?? null,
    { existingNodeParents: { ...legacyNodeParents, ...(state.existingNodeParents ?? {}) } },
  );
}


export function buildOwnedExecutionTasks(artifactRoot) {
  const { featureTasks, integrationTasks, links } = collectPlannedTaskOwnership(artifactRoot);
  const tasks = new Map();

  for (const [taskId, base] of featureTasks) {
    tasks.set(taskId, {
      id: taskId,
      title: base.title,
      intent: base.intent,
      acceptanceCriteria: structuredClone(base.acceptanceCriteria),
      testStrategy: base.testStrategy,
      verification: structuredClone(base.verification ?? []),
      interfaceIds: structuredClone(base.interfaceIds ?? []),
      logicalRefs: [base.featureId],
      dependsOn: [],
      taskKind: 'feature',
      ownerFeatureId: base.featureId,
    });
  }

  for (const [taskId, base] of integrationTasks) {
    tasks.set(taskId, {
      id: taskId,
      title: base.title,
      intent: base.intent,
      acceptanceCriteria: structuredClone(base.acceptanceCriteria),
      testStrategy: base.testStrategy,
      verification: structuredClone(base.verification ?? []),
      interfaceIds: structuredClone(base.interfaceIds ?? []),
      logicalRefs: [],
      dependsOn: [],
      taskKind: 'integration',
      ownerMilestoneId: base.milestoneId,
    });
  }

  for (const link of links) {
    const task = tasks.get(link.taskId);
    for (const dep of link.addDependsOn) if (!task.dependsOn.includes(dep)) task.dependsOn.push(dep);
    for (const verification of link.addVerification) {
      if (!task.verification.some(item => stableJson(item) === stableJson(verification))) {
        task.verification.push(structuredClone(verification));
      }
    }
    task.milestoneRefs = [...new Set([...(task.milestoneRefs ?? []), link.milestoneId])];
  }

  return [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function collectPlannedTaskOwnership(artifactRoot) {
  const featureContracts = loadBoundaryContracts(artifactRoot, 'feature');
  const milestoneContracts = loadBoundaryContracts(artifactRoot, 'milestone');

  const featureTasks = new Map();
  for (const [featureId, contract] of featureContracts) {
    for (const task of contract.featureTasks ?? []) {
      if (featureTasks.has(task.id)) fail(`duplicate canonical feature task ${task.id}`);
      featureTasks.set(task.id, { ...structuredClone(task), featureId });
    }
  }

  const integrationTasks = new Map();
  const links = [];
  for (const [milestoneId, contract] of milestoneContracts) {
    for (const task of contract.integrationTasks ?? []) {
      if (featureTasks.has(task.id) || integrationTasks.has(task.id)) {
        fail(`duplicate planned task id ${task.id}`);
      }
      integrationTasks.set(task.id, { ...structuredClone(task), milestoneId });
    }
    for (const link of contract.taskLinks ?? []) {
      if (!featureTasks.has(link.taskId)) {
        fail(`milestone:${milestoneId}: taskLink references unknown feature task ${link.taskId}`);
      }
      links.push({ milestoneId, ...structuredClone(link) });
    }
  }

  return { featureTasks, integrationTasks, links };
}

export function validateTaskOwnershipCompilation(artifactRoot, executionTasks) {
  const ownership = collectPlannedTaskOwnership(artifactRoot);
  const byId = new Map((executionTasks ?? []).map(task => [task.id, task]));

  for (const [taskId, base] of ownership.featureTasks) {
    const compiled = byId.get(taskId);
    if (!compiled) fail(`compiled plan missing feature task ${taskId}`);
    for (const key of ['title', 'intent', 'testStrategy']) {
      if (compiled[key] !== base[key]) fail(`task:${taskId}: milestone compilation illegally overrode ${key}`);
    }
    if (stableJson(compiled.acceptanceCriteria ?? []) !== stableJson(base.acceptanceCriteria ?? [])) {
      fail(`task:${taskId}: milestone compilation illegally overrode acceptanceCriteria`);
    }
    if (!(compiled.logicalRefs ?? []).includes(base.featureId)) {
      fail(`task:${taskId}: compiled feature task must retain owning feature ${base.featureId}`);
    }
  }

  for (const link of ownership.links) {
    const compiled = byId.get(link.taskId);
    if (!compiled) fail(`taskLink missing compiled task ${link.taskId}`);
    for (const dep of link.addDependsOn) {
      if (!(compiled.dependsOn ?? []).includes(dep)) {
        fail(`task:${link.taskId}: missing milestone-added dependency ${dep}`);
      }
    }
    for (const verification of link.addVerification) {
      const found = (compiled.verification ?? []).some(item => stableJson(item) === stableJson(verification));
      if (!found) fail(`task:${link.taskId}: missing milestone-added verification`);
    }
  }

  for (const [taskId] of ownership.integrationTasks) {
    if (!byId.has(taskId)) fail(`compiled plan missing milestone integration task ${taskId}`);
  }

  return { ok: true };
}


export function hasBoundaryContracts(artifactRoot, nodeType = null) {
  const { featureDir, milestoneDir } = ensureInterfaceArtifactLayout(artifactRoot);
  const hasJson = dir => readdirSync(dir, { withFileTypes: true })
    .some(entry => entry.isFile() && entry.name.endsWith('.json'));
  if (nodeType === 'feature') return hasJson(featureDir);
  if (nodeType === 'milestone') return hasJson(milestoneDir);
  return hasJson(featureDir) || hasJson(milestoneDir);
}


export function interfaceBinding(artifactRoot, nodeType, nodeId, interfaceId) {
  return loadBoundaryContracts(artifactRoot, nodeType)
    .get(nodeId)
    ?.bindings
    ?.find(binding => binding.interfaceId === interfaceId) ?? null;
}
