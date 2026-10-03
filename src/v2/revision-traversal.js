import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { loadPlannerHierarchy } from './interface-contracts.js';

const ACTIONS = new Set(['KEEP', 'AMEND', 'REMOVE', 'REFINE']);

function fail(message) {
  const error = new Error(message);
  error.code = 'REVISION_TRAVERSAL_INVALID';
  throw error;
}

function layout(artifactRoot, nodeType) {
  const root = join(artifactRoot, 'planner', 'revision', nodeType);
  const decisionsDir = join(root, 'decisions');
  const activePath = join(root, 'active.json');
  mkdirSync(decisionsDir, { recursive: true });
  return { root, decisionsDir, activePath };
}

function readDecision(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadRevisionDecisions(artifactRoot, nodeType) {
  const { decisionsDir } = layout(artifactRoot, nodeType);
  const map = new Map();
  for (const entry of readdirSync(decisionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const decision = readDecision(join(decisionsDir, entry.name));
    validateRevisionDecision(decision, nodeType);
    if (map.has(decision.nodeId)) fail(`duplicate revision decision for ${decision.nodeId}`);
    map.set(decision.nodeId, decision);
  }
  return map;
}

export function validateRevisionDecision(decision, expectedNodeType) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) fail('decision must be object');
  const allowed = new Set(['version', 'nodeType', 'nodeId', 'action', 'visitChildren', 'reason', 'patch']);
  for (const key of Object.keys(decision)) if (!allowed.has(key)) fail(`${decision.nodeId ?? '?'}: unexpected ${key}`);
  if (decision.version !== 1) fail(`${decision.nodeId ?? '?'}: version must be 1`);
  if (decision.nodeType !== expectedNodeType) fail(`${decision.nodeId ?? '?'}: nodeType must be ${expectedNodeType}`);
  if (typeof decision.nodeId !== 'string' || !decision.nodeId) fail('decision.nodeId required');
  if (!ACTIONS.has(decision.action)) fail(`${decision.nodeId}: unsupported action ${decision.action}`);
  if (typeof decision.visitChildren !== 'boolean') fail(`${decision.nodeId}: visitChildren must be boolean`);
  if (typeof decision.reason !== 'string' || !decision.reason.trim()) fail(`${decision.nodeId}: reason required`);

  if (decision.action === 'AMEND') {
    if (!decision.patch || typeof decision.patch !== 'object' || Array.isArray(decision.patch)) {
      fail(`${decision.nodeId}: AMEND requires patch`);
    }
  } else if (decision.patch != null) {
    fail(`${decision.nodeId}: patch is only allowed for AMEND`);
  }

  if (decision.action === 'REMOVE' && decision.visitChildren) {
    fail(`${decision.nodeId}: REMOVE cannot visit children`);
  }
  return structuredClone(decision);
}

function orderedReachable(tree, decisions) {
  if (!tree.root) return [];
  const queue = [tree.root.id];
  const ordered = [];
  while (queue.length) {
    const id = queue.shift();
    ordered.push(id);
    const decision = decisions.get(id);
    if (decision && decision.visitChildren === false) continue;
    for (const child of tree.childrenById.get(id) ?? []) queue.push(child);
  }
  return ordered;
}

export function nextRevisionFrontier(artifactRoot, nodeType) {
  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  if (!tree.root) return null;
  const decisions = loadRevisionDecisions(artifactRoot, nodeType);
  const reachable = orderedReachable(tree, decisions);
  for (const nodeId of reachable) {
    if (decisions.has(nodeId)) continue;
    const node = tree.byId.get(nodeId);
    return {
      nodeType,
      node: structuredClone(node),
      parent: node.parentId ? structuredClone(tree.byId.get(node.parentId)) : null,
      directChildren: (tree.childrenById.get(nodeId) ?? []).map(id => structuredClone(tree.byId.get(id))),
      priorDecision: null,
    };
  }
  return null;
}

export function beginRevisionPass(artifactRoot, nodeType) {
  const next = nextRevisionFrontier(artifactRoot, nodeType);
  const { activePath } = layout(artifactRoot, nodeType);
  if (!next) {
    writeFileSync(activePath, JSON.stringify({ version: 1, nodeType, complete: true }, null, 2) + '\n');
    return { complete: true, nodeType };
  }
  const state = { version: 1, nodeType, nodeId: next.node.id, complete: false };
  writeFileSync(activePath, JSON.stringify(state, null, 2) + '\n');
  return {
    complete: false,
    ...next,
    instruction: 'Decide this node only. Do not emit decisions for siblings, children, or ancestors in the same run.',
  };
}

export function finishRevisionPass(artifactRoot, nodeType) {
  const { activePath, decisionsDir } = layout(artifactRoot, nodeType);
  if (!existsSync(activePath)) fail('no active revision frontier');
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  if (active.nodeType !== nodeType) fail(`active revision type mismatch: ${active.nodeType}`);
  if (active.complete) return { complete: true, next: null };

  const file = join(decisionsDir, `${active.nodeId}.json`);
  if (!existsSync(file)) fail(`${nodeType}:${active.nodeId}: TL did not write revision decision`);
  const decision = validateRevisionDecision(readDecision(file), nodeType);
  if (decision.nodeId !== active.nodeId) fail(`revision decision target mismatch: expected ${active.nodeId}`);

  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  if (decision.action === 'REMOVE' && tree.root?.id === decision.nodeId) {
    fail(`${nodeType}: root cannot be removed`);
  }

  const next = nextRevisionFrontier(artifactRoot, nodeType);
  return { complete: next == null, decision, next };
}

export function revisionInstructions(artifactRoot, nodeType) {
  const { decisionsDir } = layout(artifactRoot, nodeType);
  return [
    `Write exactly one decision JSON for the active ${nodeType} node into ${decisionsDir}/<nodeId>.json.`,
    'Shape: {"version":1,"nodeType":"feature|milestone","nodeId":"...","action":"KEEP|AMEND|REMOVE|REFINE","visitChildren":true|false,"reason":"...","patch":{...}}.',
    'KEEP means this node itself stays unchanged. Set visitChildren=false only when the entire subtree is confidently unaffected.',
    'AMEND changes this node while preserving stable identity; use the smallest patch.',
    'REFINE means child structure must be reconsidered using the normal one-layer top-down frontier after traversal identifies the affected node.',
    'REMOVE deletes this node/subtree and requires its parent contract/task composition to be amended before final validation.',
    'Never rewrite the full tree during traversal. Ariad compiles node decisions into the next version.',
  ].join('\n');
}


export function compileFeatureRevisionDiff(artifactRoot, targetVersion) {
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    fail('targetVersion must be a positive integer');
  }
  const decisions = loadRevisionDecisions(artifactRoot, 'feature');
  const tree = loadPlannerHierarchy(artifactRoot, 'feature');
  const operations = [];

  for (const node of tree.items) {
    const decision = decisions.get(node.id);
    if (!decision) fail(`feature:${node.id}: missing revision decision`);
    if (decision.action === 'KEEP') continue;
    if (decision.action === 'AMEND') {
      const allowed = new Set(['title', 'summary', 'parentId']);
      for (const key of Object.keys(decision.patch ?? {})) {
        if (!allowed.has(key)) fail(`feature:${node.id}: AMEND patch cannot change ${key}`);
      }
      operations.push({
        op: 'update',
        id: node.id,
        patch: structuredClone(decision.patch),
        reason: decision.reason,
      });
      continue;
    }
    if (decision.action === 'REMOVE') {
      operations.push({ op: 'remove', id: node.id, reason: decision.reason });
      continue;
    }
    if (decision.action === 'REFINE') {
      // Structure refinement happens in the subsequent one-layer frontier pass.
      // The existing node identity remains stable here.
      continue;
    }
  }

  return { version: 1, targetVersion, operations };
}

export function revisionRefinementTargets(artifactRoot, nodeType) {
  const decisions = loadRevisionDecisions(artifactRoot, nodeType);
  return [...decisions.values()]
    .filter(decision => decision.action === 'REFINE')
    .map(decision => decision.nodeId);
}

export function validateRevisionTraversalComplete(artifactRoot, nodeType) {
  const next = nextRevisionFrontier(artifactRoot, nodeType);
  if (next) fail(`${nodeType}: revision traversal incomplete at ${next.node.id}`);
  const tree = loadPlannerHierarchy(artifactRoot, nodeType);
  const decisions = loadRevisionDecisions(artifactRoot, nodeType);

  for (const node of tree.items) {
    const decision = decisions.get(node.id);
    if (!decision) continue; // pruned by an ancestor KEEP visitChildren=false
    if (decision.action === 'REMOVE' && node.parentId) {
      const parentDecision = decisions.get(node.parentId);
      if (!parentDecision || !['AMEND', 'REFINE', 'REMOVE'].includes(parentDecision.action)) {
        fail(`${nodeType}:${node.id}: REMOVE requires parent ${node.parentId} to be AMEND/REFINE/REMOVE`);
      }
    }
  }

  return {
    ok: true,
    visited: decisions.size,
    refinementTargets: revisionRefinementTargets(artifactRoot, nodeType),
  };
}
