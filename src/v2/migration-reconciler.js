import { loadBoundaryContracts } from './interface-contracts.js';
import { resolveAnchorStatically } from './interface-seal.js';

function featureOwnerContracts(artifactRoot) {
  return loadBoundaryContracts(artifactRoot, 'feature');
}

function canAdoptFeatureTask({ artifactRoot, workspace, task }) {
  const featureId = task.ownerFeatureId ?? task.logicalRefs?.[0] ?? null;
  if (!featureId) return { adopt: false, reason: 'NO_FEATURE_OWNER' };

  const contract = featureOwnerContracts(artifactRoot).get(featureId);
  if (!contract) return { adopt: false, reason: 'FEATURE_CONTRACT_MISSING' };

  const interfaceIds = task.interfaceIds ?? [];
  if (interfaceIds.length === 0) return { adopt: false, reason: 'NO_REQUIRED_INTERFACES' };

  const byInterface = new Map((contract.bindings ?? []).map(binding => [binding.interfaceId, binding]));
  const sealed = [];

  for (const interfaceId of interfaceIds) {
    const binding = byInterface.get(interfaceId);
    if (!binding || !Array.isArray(binding.realizationAnchors) || binding.realizationAnchors.length === 0) {
      return { adopt: false, reason: 'MISSING_REALIZATION_BINDING', interfaceId };
    }

    let valid = 0;
    const evidence = [];
    for (const anchor of binding.realizationAnchors) {
      const resolved = resolveAnchorStatically({ workspace, anchor });
      evidence.push({ anchor, resolved });
      if (resolved.ok) valid += 1;
    }
    if (valid === 0) {
      return { adopt: false, reason: 'NO_RESOLVABLE_REALIZATION', interfaceId, evidence };
    }
    sealed.push({ interfaceId, validAnchors: valid });
  }

  return { adopt: true, featureId, sealed };
}

export function reconcileMigratedDeliveryTasks({
  store,
  projectId,
  artifactRoot,
  workspace,
  at = new Date().toISOString(),
}) {
  const project = store.getProject(projectId);
  if (!project?.planningModelMigration || project.planningModelMigration.status !== 'REBUILDING') {
    return [];
  }

  const results = [];
  for (const task of store.listTasks(projectId, { scope: 'delivery' })) {
    if (task.state !== 'READY') continue;

    if (task.taskKind === 'integration') {
      const updated = store.appendTaskHistory(task.id, task.version, {
        type: 'MIGRATION_RECONCILED',
        role: 'migration_reconciler',
        decision: 'VERIFY_EXISTING_INTEGRATION',
        reason: 'Milestone integration tasks verify the migrated product state rather than reimplementing canonical feature ownership.',
        at,
      }, {
        stage: 'tester',
      });
      results.push({ taskId: task.id, stage: updated.stage, decision: 'VERIFY_EXISTING_INTEGRATION' });
      continue;
    }

    const adoption = canAdoptFeatureTask({ artifactRoot, workspace, task });
    if (!adoption.adopt) {
      const updated = store.appendTaskHistory(task.id, task.version, {
        type: 'MIGRATION_RECONCILED',
        role: 'migration_reconciler',
        decision: 'REIMPLEMENT_OR_REBIND',
        reason: adoption.reason,
        interfaceId: adoption.interfaceId ?? null,
        at,
      }, {
        stage: task.art?.required ? 'artist' : 'developer',
      });
      results.push({ taskId: task.id, stage: updated.stage, decision: 'REIMPLEMENT_OR_REBIND', reason: adoption.reason });
      continue;
    }

    const updated = store.appendTaskHistory(task.id, task.version, {
      type: 'MIGRATION_RECONCILED',
      role: 'migration_reconciler',
      decision: 'ADOPT_EXISTING_IMPLEMENTATION',
      featureId: adoption.featureId,
      sealed: adoption.sealed,
      at,
    }, {
      stage: 'tester',
    });
    results.push({ taskId: task.id, stage: updated.stage, decision: 'ADOPT_EXISTING_IMPLEMENTATION' });
  }

  return results;
}
