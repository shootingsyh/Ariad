import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

const INTERFACE_TYPES = new Set(['service', 'ui', 'journey', 'event', 'data']);
const VISIBILITIES = new Set(['internal', 'exported']);

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

export function ensureInterfaceArtifactLayout(artifactRoot) {
  const plannerRoot = join(artifactRoot, 'planner');
  const interfaceRoot = join(plannerRoot, 'interfaces');
  const featureDir = join(interfaceRoot, 'features');
  const milestoneDir = join(interfaceRoot, 'milestones');
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(milestoneDir, { recursive: true });
  return { plannerRoot, interfaceRoot, featureDir, milestoneDir };
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

  const maxDepth = items.length ? Math.max(...items.map(item => depthById.get(item.id))) : -1;
  return { byId, depthById, childrenById, maxDepth };
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
  const allowed = new Set(['version', 'nodeId', 'nodeType', 'interfaces', 'imports', 'integrationScenarios']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail(`${raw.nodeId ?? '?'}: unexpected property ${key}`);
  if (raw.version !== 1) fail(`${raw.nodeId ?? '?'}: version must be 1`);
  if (raw.nodeType !== expectedNodeType) fail(`${raw.nodeId ?? '?'}: nodeType must be ${expectedNodeType}`);
  if (typeof raw.nodeId !== 'string' || !raw.nodeId) fail('contract requires nodeId');
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
    const uses = entry.uses.map((use, useIndex) => {
      if (!use || typeof use !== 'object' || Array.isArray(use)) fail(`${raw.nodeId}.integrationScenarios[${index}].uses[${useIndex}] invalid`);
      if (typeof use.nodeId !== 'string' || !use.nodeId) fail('scenario use requires nodeId');
      if (typeof use.interfaceId !== 'string' || !use.interfaceId) fail('scenario use requires interfaceId');
      return { nodeId: use.nodeId, interfaceId: use.interfaceId };
    });
    return { id: entry.id, description: entry.description, uses };
  });

  return {
    version: 1,
    nodeId: raw.nodeId,
    nodeType: raw.nodeType,
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

export function validateBoundaryContracts(artifactRoot, nodeType) {
  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  const contracts = loadBoundaryContracts(artifactRoot, nodeType);

  for (const item of tree.items) {
    const contract = contracts.get(item.id);
    if (!contract) fail(`${nodeType}:${item.id}: missing boundary contract`);

    const directChildren = new Set(tree.childrenById.get(item.id) ?? []);
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

  return { ok: true, count: contracts.size, maxDepth: tree.maxDepth };
}

export function boundaryPassContext(artifactRoot, nodeType, requestedDepth = null) {
  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  if (tree.items.length === 0) fail(`${nodeType}: hierarchy is empty`);
  const depth = requestedDepth == null ? tree.maxDepth : Number(requestedDepth);
  if (!Number.isInteger(depth) || depth < 0 || depth > tree.maxDepth) {
    fail(`${nodeType}: invalid interface depth ${requestedDepth}`);
  }
  const contracts = loadBoundaryContracts(artifactRoot, nodeType);
  const nodes = tree.items
    .filter(item => tree.depthById.get(item.id) === depth)
    .map(item => ({
      node: structuredClone(item),
      directChildren: (tree.childrenById.get(item.id) ?? []).map(childId => ({
        node: structuredClone(tree.byId.get(childId)),
        contract: structuredClone(contracts.get(childId) ?? null),
      })),
    }));

  return { nodeType, depth, maxDepth: tree.maxDepth, nodes };
}

export function boundaryArtifactInstructions(artifactRoot, nodeType, depth) {
  const { featureDir, milestoneDir } = ensureInterfaceArtifactLayout(artifactRoot);
  const dir = nodeType === 'feature' ? featureDir : milestoneDir;
  return [
    `Process only ${nodeType} nodes at depth ${depth}. Do not edit contracts for any other depth.`,
    `Write one boundary contract per current node into: ${dir}`,
    'Filename must be <nodeId>.json.',
    'Contract shape: {"version":1,"nodeId":"...","nodeType":"feature|milestone","interfaces":[{"id":"...","type":"service|ui|journey|event|data","visibility":"internal|exported","contract":"..."}],"imports":[{"fromNodeId":"direct-child-id","interfaceId":"child-export-id","purpose":"..."}],"integrationScenarios":[{"id":"...","description":"...","uses":[{"nodeId":"...","interfaceId":"..."}]}]}.',
    'A non-leaf node may import only EXPORTED interfaces of its direct children. Never reach through a child to a grandchild.',
    'interfaces visibility=internal stays inside this node. visibility=exported is the only surface the parent may depend on.',
    'integrationScenarios define how this node proves its children compose correctly. Include user-visible UI journeys when the scope exposes UI behavior.',
    'Do not bind contracts to concrete source files yet. This planning phase defines semantic boundaries, not the future code index.',
  ].join('\n');
}
