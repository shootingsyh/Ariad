import {
  loadBoundaryContracts,
  loadPlannerHierarchy,
} from './interface-contracts.js';

function exported(contract) {
  return (contract?.interfaces ?? []).filter(entry => entry.visibility === 'exported');
}

function findFeatureConsumers(featureId, featureContracts) {
  const consumers = [];
  for (const [nodeId, contract] of featureContracts) {
    for (const imported of contract.imports ?? []) {
      if (imported.fromNodeId === featureId) {
        consumers.push({
          featureId: nodeId,
          interfaceId: imported.interfaceId,
          purpose: imported.purpose,
        });
      }
    }
  }
  return consumers;
}

function milestoneFeatureUses(featureIds, milestoneContracts) {
  const wanted = new Set(featureIds);
  const uses = [];
  for (const [milestoneId, contract] of milestoneContracts) {
    for (const use of contract.featureUses ?? []) {
      if (wanted.has(use.featureId)) {
        uses.push({ milestoneId, ...structuredClone(use) });
      }
    }
  }
  return uses;
}

function compactFeature(featureId, tree, contracts, { includeInternals = false } = {}) {
  const node = tree.byId.get(featureId);
  const contract = contracts.get(featureId);
  if (!node || !contract) return null;
  return {
    id: featureId,
    title: node.title ?? null,
    summary: node.summary ?? null,
    decomposition: structuredClone(contract.decomposition),
    exports: structuredClone(exported(contract)),
    ...(includeInternals ? {
      imports: structuredClone(contract.imports ?? []),
      internalInterfaces: structuredClone(
        (contract.interfaces ?? []).filter(entry => entry.visibility === 'internal')
      ),
      localIntegrationScenarios: structuredClone(contract.integrationScenarios ?? []),
    } : {}),
  };
}

function compactMilestone(milestoneId, tree, contracts) {
  const node = tree.byId.get(milestoneId);
  const contract = contracts.get(milestoneId);
  if (!node || !contract) return null;
  return {
    id: milestoneId,
    title: node.title ?? null,
    goal: node.goal ?? null,
    acceptanceCriteria: structuredClone(node.acceptanceCriteria ?? []),
    testStrategy: node.testStrategy ?? null,
    exports: structuredClone(exported(contract)),
    imports: structuredClone(contract.imports ?? []),
    featureUses: structuredClone(contract.featureUses ?? []),
    integrationScenarios: structuredClone(contract.integrationScenarios ?? []),
  };
}

export function buildRoleBoundaryContext({ artifactRoot, task, role }) {
  if (!artifactRoot) return null;

  let featureTree;
  let milestoneTree;
  let featureContracts;
  let milestoneContracts;
  try {
    featureTree = loadPlannerHierarchy(artifactRoot, 'feature');
    milestoneTree = loadPlannerHierarchy(artifactRoot, 'milestone');
    featureContracts = loadBoundaryContracts(artifactRoot, 'feature');
    milestoneContracts = loadBoundaryContracts(artifactRoot, 'milestone');
  } catch {
    return null;
  }

  if (featureContracts.size === 0 && milestoneContracts.size === 0) return null;

  const featureIds = [...new Set(
    (task.logicalRefs ?? task.input?.logicalRefs ?? [])
      .filter(id => featureContracts.has(id))
  )];

  const milestoneIds = [...new Set([
    task.milestoneId,
    task.input?.milestoneId,
    ...(task.milestoneRefs ?? []),
  ].filter(id => id && milestoneContracts.has(id)))];

  if (role === 'developer') {
    const features = featureIds
      .map(id => compactFeature(id, featureTree, featureContracts, { includeInternals: true }))
      .filter(Boolean);
    return {
      role: 'developer',
      principle: 'Implement the assigned leaf/capability contract. Do not reverse-engineer unrelated sibling features.',
      features,
      parentExpectations: featureIds.flatMap(id => findFeatureConsumers(id, featureContracts)),
      milestoneAmendments: milestoneFeatureUses(featureIds, milestoneContracts),
    };
  }

  if (role === 'tester') {
    const milestones = milestoneIds
      .map(id => compactMilestone(id, milestoneTree, milestoneContracts))
      .filter(Boolean);
    const directlyUsedFeatureIds = new Set([
      ...featureIds,
      ...milestones.flatMap(m => (m.featureUses ?? []).map(use => use.featureId)),
    ]);
    return {
      role: 'tester',
      principle: 'Author and execute integration/contract/UI-journey/E2E verification from declared interfaces. Drill into implementation only when an interface fails.',
      milestones,
      featureInterfaces: [...directlyUsedFeatureIds]
        .map(id => compactFeature(id, featureTree, featureContracts, { includeInternals: false }))
        .filter(Boolean),
    };
  }

  if (role === 'reviewer') {
    const milestones = milestoneIds
      .map(id => compactMilestone(id, milestoneTree, milestoneContracts))
      .filter(Boolean);
    return {
      role: 'reviewer',
      principle: 'Review contract satisfaction and fresh evidence. Do not redo repository-wide discovery; drill down only to validate disputed evidence.',
      milestones,
      featureInterfaces: featureIds
        .map(id => compactFeature(id, featureTree, featureContracts, { includeInternals: false }))
        .filter(Boolean),
    };
  }

  return null;
}
