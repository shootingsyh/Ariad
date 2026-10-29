import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAutomatedRegression } from './automated-regression.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function compactBoundAnchor(entry) {
  const anchor = entry?.anchor ?? {};
  const locator = { file: anchor.file ?? null };
  if (anchor.symbol) locator.symbol = anchor.symbol;
  else if (anchor.startLine != null) locator.startLine = anchor.startLine;
  if (anchor.status && anchor.status !== 'VALID') locator.status = anchor.status;
  if (entry?.resolved?.error) locator.error = entry.resolved.error;
  return locator;
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
          anchors: [...new Map(anchors.map(item => { const anchor = compactBoundAnchor(item); return [JSON.stringify(anchor), anchor]; })).values()],
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
    .map(entry => {
      const failures = clone(entry.failures ?? []);
      const packagingOnly = entry.type === 'ROLE_SEAL_FAILED'
        && entry.repairRole === 'tester'
        && failures.length > 0
        && failures.every(failure => failure?.reason === 'MISSING_INTERFACE_VERIFICATION_EVIDENCE');
      return {
        type: entry.type,
        role: entry.role ?? null,
        ownerRole: entry.ownerRole ?? null,
        repairRole: entry.repairRole ?? null,
        failure: entry.failure ?? null,
        summary: entry.summary ?? null,
        guidance: entry.guidance ?? null,
        failures,
        ...(packagingOnly ? {
          repairKind: 'RESULT_EVIDENCE_PACKAGING',
          rerunRequired: false,
          repairInstruction: 'Reuse the immediately preceding fresh Tester execution evidence. Do not rerun tests; repair only result.interfaceVerifications evidence packaging and resubmit.',
        } : {}),
      };
    });
  return entries.length > 0 ? { events: entries } : null;
}

function uniqueReferencedFeatures(boundary) {
  const owners = new Set((boundary?.owningFeatures ?? []).map(feature => feature.id));
  const seen = new Set();
  return (boundary?.referencedFeatureInterfaces ?? [])
    .filter(feature => !owners.has(feature.id) && !seen.has(feature.id) && seen.add(feature.id))
    .map(stripBinding);
}

function interfaceLookupField(artifactRoot) {
  if (!artifactRoot) return null;
  const artifactsDir = resolve(artifactRoot);
  const ariDir = dirname(artifactsDir);
  const workspace = dirname(ariDir);
  if (basename(artifactsDir) !== 'artifacts' || basename(ariDir) !== '.ariad' || basename(workspace) !== 'workspace') return null;
  const projectName = basename(dirname(workspace));
  const projectsRoot = dirname(dirname(workspace));
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  return {
    command: `node ${cliPath} project interfaces ${projectName} --projects-root ${projectsRoot}`,
    usage: 'Resolve an interfaceId to its boundary contract with the ariad_interface_contract tool (omit the id to list all interfaces), or with this command by appending --id <interfaceId>. Use these instead of searching the filesystem for interface contracts.',
  };
}

/**
 * Prompt-render slimming. The canonical artifact on disk stays complete
 * (the seal revalidates bindings from it, and TASK ARTIFACT PATH points
 * models at it), but the copy serialized into a role prompt does not
 * need seal bookkeeping: bindings collapse to a (file, symbol, line)
 * index, referenced-feature interfaces and milestones collapse to
 * id/title stubs (full contracts resolve through the interface tool),
 * and passed regression tests collapse to a count - failures keep
 * their full evidence. Small artifacts pass through untouched.
 */
export const PROMPT_SLIM_THRESHOLD_BYTES = 24 * 1024;

function slimAnchorEntry(entry) {
  const anchor = entry?.anchor ?? entry;
  if (!anchor || typeof anchor !== 'object') return entry;
  return {
    ...(anchor.kind ? { kind: anchor.kind } : {}),
    file: anchor.file ?? null,
    ...(anchor.symbol ? { symbol: anchor.symbol } : {}),
    ...(anchor.startLine != null ? { startLine: anchor.startLine } : {}),
  };
}

function slimBindings(bindings) {
  if (!Array.isArray(bindings)) return bindings;
  return bindings.map(binding => ({
    ...(binding?.featureId ? { featureId: binding.featureId } : {}),
    ...(binding?.interfaceId ? { interfaceId: binding.interfaceId } : {}),
    anchors: Array.isArray(binding?.anchors) ? binding.anchors.map(slimAnchorEntry) : [],
  }));
}

function stubEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return {
    id: entry.id ?? null,
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.name && !entry.title ? { name: entry.name } : {}),
  };
}

export function slimTaskArtifactForPrompt(artifact) {
  if (!artifact || typeof artifact !== 'object') return artifact;
  let serialized;
  try { serialized = JSON.stringify(artifact); } catch { return artifact; }
  if (serialized.length <= PROMPT_SLIM_THRESHOLD_BYTES) return artifact;
  const slim = structuredClone(artifact);
  for (const slot of ['developer', 'tester', 'reviewer', 'artist']) {
    const roleSlot = slim[slot];
    if (!roleSlot || typeof roleSlot !== 'object') continue;
    if (roleSlot.interfaceRealizations) roleSlot.interfaceRealizations = slimBindings(roleSlot.interfaceRealizations);
    if (roleSlot.interfaceVerifications) roleSlot.interfaceVerifications = slimBindings(roleSlot.interfaceVerifications);
    if (roleSlot.interfaceReviews) roleSlot.interfaceReviews = slimBindings(roleSlot.interfaceReviews);
  }
  if (slim.contracts && typeof slim.contracts === 'object') {
    if (Array.isArray(slim.contracts.referencedFeatureInterfaces)) {
      slim.contracts.referencedFeatureInterfaces = slim.contracts.referencedFeatureInterfaces.map(stubEntry);
    }
    if (Array.isArray(slim.contracts.milestones)) {
      slim.contracts.milestones = slim.contracts.milestones.map(stubEntry);
    }
  }
  const regression = slim.automatedRegression;
  if (regression && Array.isArray(regression.tests)) {
    const failures = regression.tests.filter(entry => entry?.status && entry.status !== 'PASS');
    regression.testSummary = { total: regression.tests.length, failed: failures.length };
    regression.failures = failures;
    delete regression.tests;
  }
  return slim;
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
    interfaceLookup: interfaceLookupField(artifactRoot),
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
