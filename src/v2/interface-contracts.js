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

function normalizeContract(raw, expectedNodeType) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('contract must be object');
  const allowed = new Set([
    'version', 'nodeId', 'nodeType', 'decomposition',
    'interfaces', 'imports', 'integrationScenarios', 'featureUses', 'bindings',
    'featureTasks', 'taskLinks', 'integrationTasks', 'behavior',
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

  const behaviorRaw = raw.behavior ?? [];
  if (!Array.isArray(behaviorRaw)) fail(`${raw.nodeId}: behavior must be array`);
  const behavior = behaviorRaw.map((clause, clauseIndex) => {
    if (typeof clause !== 'string' || !clause.trim()) fail(`${raw.nodeId}.behavior[${clauseIndex}]: non-empty string required`);
    return clause.trim();
  });
  if (expectedNodeType === 'milestone' && behavior.length) {
    fail(`${raw.nodeId}: milestone contracts do not carry behavior; behavior belongs to leaf feature contracts`);
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
    const keys = new Set(['id', 'description', 'uses', 'acceptanceCriteria', 'invariants']);
    for (const key of Object.keys(entry)) if (!keys.has(key)) fail(`${raw.nodeId}.integrationScenarios[${index}].${key} unexpected`);
    if (typeof entry.id !== 'string' || !entry.id) fail(`${raw.nodeId}.integrationScenarios[${index}].id required`);
    if (typeof entry.description !== 'string' || !entry.description.trim()) fail(`${raw.nodeId}.integrationScenarios[${index}].description required`);
    if (!Array.isArray(entry.uses)) fail(`${raw.nodeId}.integrationScenarios[${index}].uses must be array`);
    const normalizeClauseList = (value, field) => {
      if (value == null) return [];
      if (!Array.isArray(value)) fail(`${raw.nodeId}.integrationScenarios[${index}].${field} must be array`);
      return value.map((clause, clauseIndex) => {
        if (typeof clause !== 'string' || !clause.trim()) fail(`${raw.nodeId}.integrationScenarios[${index}].${field}[${clauseIndex}]: non-empty string required`);
        return clause.trim();
      });
    };
    return {
      id: entry.id,
      description: entry.description,
      acceptanceCriteria: normalizeClauseList(entry.acceptanceCriteria, 'acceptanceCriteria'),
      invariants: normalizeClauseList(entry.invariants, 'invariants'),
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
    const allowed = new Set(['id', 'title', 'intent', 'acceptanceCriteria', 'testStrategy', 'verification', 'interfaceIds', 'issueRefs']);
    for (const key of Object.keys(task)) if (!allowed.has(key)) fail(`${path}.${key}: unexpected property`);
    for (const key of ['id', 'title', 'intent', 'testStrategy']) {
      if (typeof task[key] !== 'string' || !task[key].trim()) fail(`${path}.${key}: required`);
    }
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      fail(`${path}.acceptanceCriteria: non-empty array required`);
    }
    if (task.verification != null && !Array.isArray(task.verification)) fail(`${path}.verification: must be array`);
    if (task.interfaceIds != null && !Array.isArray(task.interfaceIds)) fail(`${path}.interfaceIds: must be array`);
    if (task.issueRefs != null && !Array.isArray(task.issueRefs)) fail(`${path}.issueRefs: must be array`);
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
      issueRefs: [...(task.issueRefs ?? [])],
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
    behavior,
  };
}

export function loadBoundaryContracts(artifactRoot, nodeType) {
  const { featureDir, milestoneDir } = ensureInterfaceArtifactLayout(artifactRoot);
  const dir = nodeType === 'feature' ? featureDir : milestoneDir;
  const contracts = readJsonDir(dir).map(raw => normalizeContract(raw, nodeType));
  return new Map(contracts.map(contract => [contract.nodeId, contract]));
}

