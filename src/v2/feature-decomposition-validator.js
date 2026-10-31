import { loadBoundaryContracts, loadPlannerHierarchy, validateBoundaryContracts } from './interface-contracts.js';
import { validateFeatureDocs } from './project-docs.js';

function fail(message) {
  const error = new Error('FEATURE_DECOMPOSITION_INCOMPLETE: ' + message);
  error.code = 'FEATURE_DECOMPOSITION_INCOMPLETE';
  throw error;
}

/**
 * Plan-time proof that a decomposition iteration cannot ship a feature-only
 * tree diff without corresponding interface and acceptance ownership.
 * No implementation PASS or runtime evidence is inferred from these plans.
 */
export function validateFeatureDecompositionIteration(artifactRoot, diff, compiledTasks = [], { workspace = null } = {}) {
  if (!diff || !Array.isArray(diff.operations)) fail('feature-tree-diff.json required');
  const added = diff.operations.filter(item => item.op === 'add').map(item => item.node?.id);
  if (added.length === 0) fail('decomposition must add at least one independently testable feature');
  const tree = loadPlannerHierarchy(artifactRoot, 'feature');
  const contracts = loadBoundaryContracts(artifactRoot, 'feature');
  validateBoundaryContracts(artifactRoot, 'feature', { allowFrontier: false });

  const byTask = new Map(compiledTasks.map(task => [task.id, task]));
  const additions = new Set(added);
  const changedParents = new Set();
  for (const nodeId of added) {
    const node = tree.byId.get(nodeId);
    const contract = contracts.get(nodeId);
    if (!node || !contract) fail(`added feature ${nodeId} needs a matching logical node and boundary contract`);
    if (node.parentId == null) fail(`added feature ${nodeId} cannot replace the root`);
    changedParents.add(node.parentId);
    if (contract.interfaces.length === 0) fail(`added feature ${nodeId} must define a semantic interface`);
    if (contract.decomposition.kind === 'leaf' && !(contract.behavior?.length)) {
      fail(`added leaf feature ${nodeId} requires behavior clauses (contract behavior layer)`);
    }
    for (const scenario of contract.integrationScenarios) {
      if (!scenario.acceptanceCriteria?.length) {
        fail(`added feature ${nodeId} scenario ${scenario.id} requires acceptanceCriteria (contract behavior layer)`);
      }
    }
    for (const entry of contract.interfaces) {
      if (!entry.verificationSketch?.trim() && entry.verification.length === 0) {
        fail(`interface ${nodeId}/${entry.id} requires verificationSketch or verification anchors`);
      }
    }
    const parent = contracts.get(node.parentId);
    if (!parent) fail(`added feature ${nodeId} has no parent boundary contract`);
    const exported = new Set(contract.interfaces.filter(x => x.visibility === 'exported').map(x => x.id));
    const imported = parent.imports.filter(x => x.fromNodeId === nodeId && exported.has(x.interfaceId));
    if (imported.length === 0) fail(`parent ${node.parentId} must import an exported interface from ${nodeId}`);
    const usesNewChild = parent.integrationScenarios.some(s =>
      s.uses.some(u => u.graph === 'feature' && u.nodeId === nodeId && imported.some(x => x.interfaceId === u.interfaceId))
    );
    if (!usesNewChild) fail(`parent ${node.parentId} must integrate ${nodeId} in a scenario`);

    if (contract.decomposition.kind === 'leaf') {
      const tasks = contract.featureTasks ?? [];
      if (tasks.length === 0) fail(`new leaf ${nodeId} requires a canonical feature task (reuse/verify is allowed)`);
      for (const task of tasks) {
        const compiled = byTask.get(task.id);
        if (!compiled) fail(`feature task ${task.id} missing from compiled Task Graph`);
        if (!(compiled.logicalRefs ?? []).includes(nodeId)) fail(`task ${task.id} must be owned by ${nodeId}`);
        const ownedInterfaces = new Set(contract.interfaces.map(x => x.id));
        if (!task.interfaceIds?.length || task.interfaceIds.some(id => !ownedInterfaces.has(id))) {
          fail(`task ${task.id} requires valid interfaceIds from ${nodeId}`);
        }
        if (!compiled.acceptanceCriteria?.length || !compiled.verification?.length) {
          fail(`task ${task.id} must have acceptance criteria and planned verification`);
        }
      }
    }
  }

  // Document system (design 2026-10-30): when the project keeps a docs root,
  // tree changes and feature documents must land in the same batch — every
  // added/updated feature needs its .ariad/docs/features/<id>.md document and
  // a FEATURES.md index entry; removed features must leave the index.
  if (workspace) {
    const changedNodeIds = diff.operations
      .filter(item => item.op === 'add' || item.op === 'update')
      .map(item => (item.op === 'add' ? item.node?.id : item.id))
      .filter(Boolean);
    const removedNodeIds = diff.operations
      .filter(item => item.op === 'remove')
      .map(item => item.id)
      .filter(Boolean);
    try {
      validateFeatureDocs(workspace, { changedNodeIds, removedNodeIds });
    } catch (error) {
      fail(error.message.replace(/^PROJECT_DOCS_INCOMPLETE: /, ''));
    }
  }

  // Parent interfaces remain stable: validateBoundaryContracts already checks
  // frozen exports. Every new edge must now be represented in imports + E2E.
  return { ok: true, addedFeatures: added.length, changedParents: changedParents.size };
}
