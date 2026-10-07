import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAutomatedRegression } from './automated-regression.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function compactResolved(resolved) {
  if (!resolved) return null;
  if (resolved.error) return { error: resolved.error };
  return {
    fileHash: resolved.fileHash ?? null,
    range: clone(resolved.range ?? null),
    resolver: resolved.resolver ?? null,
  };
}

function compactBoundAnchor(entry) {
  return {
    anchor: clone(entry?.anchor ?? null),
    resolved: compactResolved(entry?.resolved),
  };
}

function stripBinding(feature) {
  const next = clone(feature);
  next.interfaces = (next.interfaces ?? []).map(iface => {
    const { binding: _binding, ...contract } = iface;
    return contract;
  });
  return next;
}

function collectBindings(boundary, kind) {
  const seen = new Set();
  const interfaces = [];
  for (const groupName of ['owningFeatures', 'referencedFeatureInterfaces']) {
    for (const feature of boundary?.[groupName] ?? []) {
      for (const iface of feature.interfaces ?? []) {
        const anchors = iface.binding?.[kind] ?? [];
        if (anchors.length === 0) continue;
        const key = `${feature.id}:${iface.id}:${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        interfaces.push({
          featureId: feature.id,
          interfaceId: iface.id,
          anchors: anchors.map(compactBoundAnchor),
        });
      }
    }
  }
  return interfaces;
}

function latestRoleResult(history, role) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type === 'ROLE_RESULT' && entry.role === role) return entry;
  }
  return null;
}

function compactRoleResult(entry, role) {
  if (!entry) return null;
  const common = {
    outcome: entry.outcome ?? null,
    summary: entry.summary ?? null,
    keyPoints: clone(entry.keyPoints ?? []),
    artifacts: clone(entry.artifacts ?? []),
  };
  if (role === 'tester') {
    return {
      ...common,
      criteria: clone(entry.result?.criteria ?? []),
      interfaceEvidence: (entry.result?.interfaceVerifications ?? []).map(item => ({
        interfaceId: item.interfaceId,
        evidence: clone(item.evidence ?? []),
      })),
    };
  }
  if (role === 'reviewer') {
    return {
      ...common,
      interfaceReviews: clone(entry.result?.interfaceReviews ?? []),
    };
  }
  return common;
}

function repairSlot(history) {
  const entries = history
    .filter(entry => [
      'SYSTEM_INTERRUPTION',
      'SYSTEM_RECOVERY',
      'ROLE_SEAL_FAILED',
      'INTERFACE_SEAL_FAILED',
      'DEBUGGER_ROUTE',
      'PRODUCT_DECISION',
    ].includes(entry?.type))
    .slice(-8)
    .map(entry => ({
      type: entry.type,
      role: entry.role ?? null,
      failure: entry.failure ?? null,
      summary: entry.summary ?? null,
      guidance: entry.guidance ?? null,
      failures: clone(entry.failures ?? []),
    }));
  return entries.length > 0 ? { events: entries } : null;
}

function uniqueReferencedFeatures(boundary) {
  const owners = new Set((boundary?.owningFeatures ?? []).map(feature => feature.id));
  const seen = new Set();
  return (boundary?.referencedFeatureInterfaces ?? [])
    .filter(feature => !owners.has(feature.id) && !seen.has(feature.id) && seen.add(feature.id))
    .map(stripBinding);
}

export function buildTaskContextArtifact({ task, boundaryContext, artifactRoot = null }) {
  const history = task?.history ?? [];
  const developerResult = latestRoleResult(history, 'developer');
  const testerResult = latestRoleResult(history, 'tester');
  const reviewerResult = latestRoleResult(history, 'reviewer');
  const artistResult = latestRoleResult(history, 'artist');
  const realizationBindings = collectBindings(boundaryContext, 'realization');
  const verificationBindings = collectBindings(boundaryContext, 'verification');

  return {
    schema: 'ariad-task-context-v1',
    task: {
      id: task.id,
      title: task.title ?? null,
      intent: task.intent ?? task.input?.intent ?? null,
      acceptanceCriteria: clone(task.acceptanceCriteria ?? task.input?.acceptanceCriteria ?? []),
      acceptanceCriterionIds: clone(task.acceptanceCriterionIds ?? []),
      verification: clone(task.verification ?? task.input?.verification ?? []),
      testStrategy: task.testStrategy ?? task.input?.testStrategy ?? null,
      art: clone(task.art ?? task.input?.art ?? null),
      owningFeatureRefs: clone(task.logicalRefs ?? task.input?.logicalRefs ?? []),
      milestoneId: task.milestoneId ?? task.input?.milestoneId ?? null,
      requiredInterfaceIds: clone(task.interfaceIds ?? task.input?.interfaceIds ?? []),
    },
    contracts: boundaryContext ? {
      principle: boundaryContext.principle ?? null,
      owningFeatures: (boundaryContext.owningFeatures ?? []).map(stripBinding),
      referencedFeatureInterfaces: uniqueReferencedFeatures(boundaryContext),
      milestones: clone(boundaryContext.milestones ?? []),
    } : null,
    dependencies: boundaryContext ? {
      parentExpectations: clone(boundaryContext.parentExpectations ?? []),
      milestoneUses: clone(boundaryContext.milestoneUses ?? []),
    } : null,
    artist: compactRoleResult(artistResult, 'artist'),
    developer: developerResult || realizationBindings.length > 0 ? {
      ...compactRoleResult(developerResult, 'developer'),
      interfaceRealizations: realizationBindings,
    } : null,
    automatedRegression: readAutomatedRegression(artifactRoot, task.id),
    tester: testerResult || verificationBindings.length > 0 ? {
      ...compactRoleResult(testerResult, 'tester'),
      interfaceVerifications: verificationBindings,
    } : null,
    reviewer: compactRoleResult(reviewerResult, 'reviewer'),
    repair: repairSlot(history),
  };
}

export function writeTaskContextArtifact(artifactRoot, artifact) {
  if (!artifactRoot || !artifact?.task?.id) return null;
  const hash = createHash('sha256').update(artifact.task.id).digest('hex').slice(0, 10);
  const safeId = artifact.task.id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96);
  const dir = join(artifactRoot, 'task-context');
  const path = join(dir, `${safeId}-${hash}.json`);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return path;
}
