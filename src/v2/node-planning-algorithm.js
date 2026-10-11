// Pure, deterministic planning traversal and validation gates. This is an
// execution-layer protocol: it does not change Feature/Milestone/Task schemas.
const PHASES = ['feature', 'milestone', 'interface'];
const GATES = ['node_validator', 'parent_critic', 'global_validator', 'global_critic'];
const clone = value => structuredClone(value);

export function nodePlanningSchedule({ phase, nodes, rootId, operation = 'PLAN' }) {
  if (!PHASES.includes(phase)) throw new Error(`unsupported phase ${phase}`);
  if (!['PLAN', 'REPLAN'].includes(operation)) throw new Error(`unsupported operation ${operation}`);
  if (!Array.isArray(nodes)) throw new Error('nodes must be an array');
  const byId = new Map();
  const children = new Map();
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || !node.id || byId.has(node.id)) throw new Error('invalid or duplicate node id');
    byId.set(node.id, node);
    children.set(node.id, []);
  }
  if (!byId.has(rootId)) throw new Error(`unknown root ${rootId}`);
  for (const node of nodes) {
    if (node.parentId != null) {
      if (!byId.has(node.parentId)) throw new Error(`missing parent ${node.parentId}`);
      children.get(node.parentId).push(node.id);
    }
  }
  for (const siblings of children.values()) siblings.sort();
  const visited = new Set();
  const active = new Set();
  const sequence = [];
  const visit = id => {
    if (active.has(id)) throw new Error(`cycle at ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    if (phase !== 'interface') sequence.push(id);
    for (const child of children.get(id)) visit(child);
    if (phase === 'interface') sequence.push(id);
    active.delete(id);
    visited.add(id);
  };
  visit(rootId);
  if (visited.size !== nodes.length) throw new Error('unreachable nodes in planning scope');
  const steps = [];
  for (const id of sequence) {
    steps.push({ kind: 'planner', phase, nodeId: id, operation });
    steps.push({ kind: 'node_validator', phase, nodeId: id });
    // A parent critic checks direct-child decomposition, never an individual leaf.
    if (children.get(id).length) steps.push({ kind: 'parent_critic', phase, nodeId: id });
  }
  steps.push({ kind: 'global_validator', phase, nodeId: rootId });
  steps.push({ kind: 'global_critic', phase, nodeId: rootId });
  return steps;
}

export function nodePlanningContext({ phase, operation, nodes, nodeId, projectBrief = null, featureManifest = [] }) {
  if (!PHASES.includes(phase)) throw new Error(`unsupported phase ${phase}`);
  if (!['PLAN', 'REPLAN'].includes(operation)) throw new Error(`unsupported operation ${operation}`);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const current = byId.get(nodeId);
  if (!current) throw new Error(`unknown node ${nodeId}`);
  const parent = current.parentId == null ? null : byId.get(current.parentId);
  if (current.parentId != null && !parent) throw new Error(`missing parent ${current.parentId}`);
  const children = nodes.filter(node => node.parentId === nodeId).sort((a,b)=>a.id.localeCompare(b.id));
  const root = parent == null;
  const isMilestoneRoot = phase === 'milestone' && root;
  const featureScope = isMilestoneRoot ? featureManifest : featureManifest.filter(f =>
    (current.featureScope ?? parent?.featureScope ?? []).includes(f.id));
  return {
    phase, operation, nodeId,
    // Put these stable fields first for shared-prefix caching among siblings.
    parent: parent ? clone(parent) : null,
    projectBrief: root ? clone(projectBrief) : null,
    current: clone(current),
    // PLAN only needs the parent/current; REPLAN sees direct children.
    existingChildren: operation === 'REPLAN' ? clone(children) : [],
    featureManifest: phase === 'milestone' ? clone(featureScope.map(f => ({
      id: f.id, parentId: f.parentId ?? null, title: f.title ?? null, summary: f.summary ?? null,
    }))) : [],
    outputBoundary: 'DIRECT_CHILDREN_ONLY',
  };
}

export function validateChildPatch({ nodes, parentId, operations }) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(parentId)) throw new Error('unknown patch parent');
  if (!Array.isArray(operations)) throw new Error('operations must be array');
  const seen = new Set();
  for (const change of operations) {
    if (!['KEEP', 'ADD', 'UPDATE', 'REMOVE'].includes(change?.op)) throw new Error('invalid patch operation');
    const id = change.op === 'ADD' ? change.node?.id : change.nodeId;
    if (typeof id !== 'string' || !id || seen.has(id)) throw new Error('duplicate or missing patch id');
    seen.add(id);
    if (change.op === 'ADD') {
      if (byId.has(id) || change.node.parentId !== parentId) throw new Error('ADD must create a direct child');
    } else {
      const existing = byId.get(id);
      if (!existing || existing.parentId !== parentId) throw new Error('operation must target a direct child');
      if (change.op === 'UPDATE' && (!change.changes || 'parentId' in change.changes || 'id' in change.changes)) {
        throw new Error('UPDATE cannot reparent or rename child');
      }
      if (change.op === 'REMOVE' && nodes.some(node => node.parentId === id)) {
        throw new Error('REMOVE requires separate descendant migration');
      }
    }
  }
  return true;
}

export function planningGatePolicy() {
  return { gates: [...GATES], nodeRepairLimit: 2, parentRepairLimit: 2, globalFailure: 'RETURN_TO_TECH_LEAD',
    failureLimit: 'PROJECT_DEBUGGER', skipStage: 'SKIP_ALL_GATES' };
}

// Gate outcomes are consumed by the scheduler, never selected by a planner.
// `attempts` counts prior repairs of this gate for this node.
export function resolvePlanningGate({ kind, passed, attempts = 0 }) {
  if (!GATES.includes(kind)) throw new Error(`unsupported gate ${kind}`);
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error('invalid repair count');
  if (passed) return { action: 'ADVANCE' };
  if (kind === 'global_validator' || kind === 'global_critic') {
    return { action: 'RETURN_TO_TECH_LEAD' };
  }
  if (attempts >= 2) return { action: 'PROJECT_DEBUGGER' };
  return { action: 'RETRY_NODE', nextAttempt: attempts + 1 };
}
