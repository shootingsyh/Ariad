import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const INTERFACE_TYPES = new Set(['service', 'ui', 'journey', 'event', 'data']);
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
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(milestoneDir, { recursive: true });
  return { plannerRoot, interfaceRoot, featureDir, milestoneDir, frozenExportsPath };
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
    'interfaces', 'imports', 'integrationScenarios',
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

  const interfaceIds = new Set();
  const interfaces = raw.interfaces.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${raw.nodeId}.interfaces[${index}] invalid`);
    const keys = new Set(['id', 'type', 'visibility', 'contract']);
    for (const key of Object.keys(entry)) if (!keys.has(key)) fail(`${raw.nodeId}.interfaces[${index}].${key} unexpected`);
    if (typeof entry.id !== 'string' || !entry.id) fail(`${raw.nodeId}.interfaces[${index}].id required`);
    if (interfaceIds.has(entry.id)) fail(`${raw.nodeId}: duplicate interface ${entry.id}`);
    interfaceIds.add(entry.id);
    if (!INTERFACE_TYPES.has(entry.type)) fail(`${raw.nodeId}.${entry.id}: invalid type ${entry.type}`);
    if (!VISIBILITIES.has(entry.visibility)) fail(`${raw.nodeId}.${entry.id}: invalid visibility ${entry.visibility}`);
    if (typeof entry.contract !== 'string' || !entry.contract.trim()) fail(`${raw.nodeId}.${entry.id}: contract required`);
    return structuredClone(entry);
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
        return { nodeId: use.nodeId, interfaceId: use.interfaceId };
      }),
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
    .map(entry => structuredClone(entry));
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

    const available = new Set([
      ...contract.interfaces.map(entry => `${item.id}:${entry.id}`),
      ...contract.imports.map(entry => `${entry.fromNodeId}:${entry.interfaceId}`),
    ]);
    for (const scenario of contract.integrationScenarios) {
      for (const use of scenario.uses) {
        if (!available.has(`${use.nodeId}:${use.interfaceId}`)) {
          fail(`${nodeType}:${item.id}: scenario ${scenario.id} uses unavailable interface ${use.nodeId}/${use.interfaceId}`);
        }
      }
    }
  }

  for (const nodeId of contracts.keys()) {
    if (!tree.byId.has(nodeId)) fail(`${nodeType}: orphan boundary contract ${nodeId}`);
  }

  freezeAndValidateExports(artifactRoot, nodeType, contracts);
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
    if (!contract) fail(`${nodeType}:${node.id}: missing contract before frontier selection`);
    const children = tree.childrenById.get(node.id) ?? [];
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
    return {
      nodeType,
      bootstrap: true,
      instruction: `Create the single ${nodeType} root, define its complete boundary contract, and if it needs decomposition create exactly one direct-child layer with complete child contracts.`,
    };
  }
  if (!frontier) return { nodeType, complete: true };
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
    'Contract shape: {"version":1,"nodeId":"...","nodeType":"feature|milestone","decomposition":{"kind":"leaf|expand","reason":"..."},"interfaces":[{"id":"...","type":"service|ui|journey|event|data","visibility":"internal|exported","contract":"..."}],"imports":[{"fromNodeId":"direct-child-id","interfaceId":"child-export-id","purpose":"..."}],"integrationScenarios":[{"id":"...","description":"...","uses":[{"nodeId":"...","interfaceId":"..."}]}]}.',
    'TOP-DOWN RULE: define a node boundary before looking below it.',
    'ONE-LAYER RULE: in one run create or refine only the current node and its direct children. Never create grandchildren.',
    'ENCAPSULATION RULE: a parent may depend only on direct-child exported interfaces.',
    'STABILITY RULE: once an exported interface has been exposed upward, later refinement must preserve it exactly unless a replan explicitly revises the ancestor contract.',
    'A leaf owns implementation/local correctness. A non-leaf owns integration scenarios over direct-child exports.',
    'Do not bind these contracts to concrete source files yet. Code indexing comes later.',
  ].join('\n');
}
