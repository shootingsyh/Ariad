import {
  loadBoundaryContracts,
  loadPlannerHierarchy,
} from './interface-contracts.js';
import { resolveAnchorStatically } from './interface-seal.js';

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

function selectTaskInterfaces(task) {
  return [...new Set(task.interfaceIds ?? task.input?.interfaceIds ?? [])];
}

function compactFeature(featureId, tree, contracts, {
  includeInternals = false,
  interfaceIds = [],
} = {}) {
  const node = tree.byId.get(featureId);
  const contract = contracts.get(featureId);
  if (!node || !contract) return null;
  const wanted = new Set(interfaceIds);
  const selected = (contract.interfaces ?? []).filter(entry => wanted.has(entry.id));
  const visible = includeInternals ? selected : selected.filter(entry => entry.visibility === 'exported');
  return {
    id: featureId,
    title: node.title ?? null,
    summary: node.summary ?? null,
    decomposition: structuredClone(contract.decomposition),
    interfaces: structuredClone(visible),
    ...(includeInternals ? {
      imports: structuredClone(contract.imports ?? []),
      localIntegrationScenarios: structuredClone(contract.integrationScenarios ?? []),
    } : {}),
  };
}

function resolveInterfaceAnchors(feature, contract, workspace, includeSnippets = false) {
  if (!contract) return feature;
  const bindings = new Map((contract.bindings ?? []).map(binding => [binding.interfaceId, binding]));
  const materialize = anchors => (anchors ?? []).map(anchor => {
    const resolved = workspace ? resolveAnchorStatically({ workspace, anchor }) : null;
    return { anchor: structuredClone(anchor), resolved: !resolved ? null : resolved.ok ? {
      fileHash: resolved.fileHash, range: resolved.range, ...(includeSnippets ? { snippet: resolved.snippet } : {}), resolver: 'static-preload',
    } : { error: resolved.reason } };
  });
  return {
    ...feature,
    interfaces: feature.interfaces.map(iface => {
      const binding = bindings.get(iface.id);
      return { ...iface, binding: binding ? {
        realization: materialize(binding.realizationAnchors),
        verification: materialize(binding.verificationAnchors),
      } : null };
    }),
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


function buildSharedDeliveryContext({
  featureIds,
  milestoneIds,
  featureTree,
  milestoneTree,
  featureContracts,
  milestoneContracts,
  task,
  workspace,
}) {
  const milestones = milestoneIds
    .map(id => compactMilestone(id, milestoneTree, milestoneContracts))
    .filter(Boolean);

  const localInterfaceIds = selectTaskInterfaces(task);
  const owningFeatures = featureIds.map(id => compactFeature(id, featureTree, featureContracts, {
    includeInternals: true, interfaceIds: localInterfaceIds,
  })).filter(Boolean).map(feature => resolveInterfaceAnchors(feature, featureContracts.get(feature.id), workspace));
  const referencedFeatureInterfaces = featureIds.map(id => compactFeature(id, featureTree, featureContracts, {
    includeInternals: false, interfaceIds: localInterfaceIds,
  })).filter(Boolean).map(feature => resolveInterfaceAnchors(feature, featureContracts.get(feature.id), workspace));

  return {
    role: 'delivery',
    principle: 'Developer, Tester, and Reviewer operate on the same task context, interface set, bindings, diff boundary, and evidence surface. Their responsibilities differ only by role instructions.',
    owningFeatures,
    referencedFeatureInterfaces,
    milestones: milestones.map(({ featureUses: _featureUses, ...milestone }) => milestone),
    parentExpectations: featureIds.flatMap(id => findFeatureConsumers(id, featureContracts)),
    milestoneUses: milestoneFeatureUses(featureIds, milestoneContracts),
  };
}

export function buildRoleBoundaryContext({ artifactRoot, task, role, workspace = null }) {
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

  if (role === 'delivery') {
    return buildSharedDeliveryContext({
      featureIds,
      milestoneIds,
      featureTree,
      milestoneTree,
      featureContracts,
      milestoneContracts,
      task,
      workspace,
    });
  }

  if (role === 'developer') {
    const requestedInterfaceIds = selectTaskInterfaces(task);
    const features = featureIds
      .map(id => compactFeature(id, featureTree, featureContracts, {
        includeInternals: true,
        interfaceIds: requestedInterfaceIds,
        workspace,
      }))
      .filter(Boolean).map(feature => resolveInterfaceAnchors(feature, featureContracts.get(feature.id), workspace));
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
    const selected = new Map();
    const localInterfaceIds = task.interfaceIds ?? task.input?.interfaceIds ?? [];
    for (const featureId of featureIds) {
      selected.set(featureId, new Set(localInterfaceIds));
    }
    for (const milestone of milestones) {
      for (const use of milestone.featureUses ?? []) {
        if (!selected.has(use.featureId)) selected.set(use.featureId, new Set());
        selected.get(use.featureId).add(use.interfaceId);
      }
    }
    return {
      role: 'tester',
      principle: 'Author and execute integration/contract/UI-journey/E2E verification from declared interfaces. Drill into implementation only when an interface fails.',
      milestones,
      featureInterfaces: [...selected.entries()]
        .map(([id, ids]) => compactFeature(id, featureTree, featureContracts, {
          includeInternals: false,
          interfaceIds: [...ids],
          workspace,
        }))
        .filter(Boolean).map(feature => resolveInterfaceAnchors(feature, featureContracts.get(feature.id), workspace, true)),
    };
  }

  if (role === 'reviewer') {
    const milestones = milestoneIds
      .map(id => compactMilestone(id, milestoneTree, milestoneContracts))
      .filter(Boolean);
    const selected = new Map();
    const localInterfaceIds = task.interfaceIds ?? task.input?.interfaceIds ?? [];
    for (const featureId of featureIds) {
      selected.set(featureId, new Set(localInterfaceIds));
    }
    for (const milestone of milestones) {
      for (const use of milestone.featureUses ?? []) {
        if (!selected.has(use.featureId)) selected.set(use.featureId, new Set());
        selected.get(use.featureId).add(use.interfaceId);
      }
    }
    return {
      role: 'reviewer',
      principle: 'Review contract satisfaction and fresh evidence. Do not redo repository-wide discovery; drill down only to validate disputed evidence.',
      milestones,
      featureInterfaces: [...selected.entries()]
        .map(([id, ids]) => compactFeature(id, featureTree, featureContracts, {
          includeInternals: false,
          interfaceIds: [...ids],
          workspace,
        }))
        .filter(Boolean).map(feature => resolveInterfaceAnchors(feature, featureContracts.get(feature.id), workspace, true)),
    };
  }

  return null;
}
