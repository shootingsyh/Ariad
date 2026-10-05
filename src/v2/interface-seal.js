import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ensureInterfaceArtifactLayout,
  loadBoundaryContracts,
} from './interface-contracts.js';

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function headCommit(workspace) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localResolveSymbol(workspace, anchor) {
  const absolute = resolve(workspace, anchor.file);
  if (!existsSync(absolute)) return null;
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  const leaf = String(anchor.symbol ?? '').split('.').at(-1);
  if (!leaf) return null;

  const patterns = [
    new RegExp(`^\\s*func\\s+${escapeRegExp(leaf)}\\s*\\(`),
    new RegExp(`^\\s*(?:class|class_name)\\s+${escapeRegExp(leaf)}\\b`),
    new RegExp(`^\\s*(?:const|var|let)\\s+${escapeRegExp(leaf)}\\b`),
  ];
  const index = lines.findIndex(line => patterns.some(pattern => pattern.test(line)));
  if (index < 0) return null;

  let end = index;
  const indent = lines[index].match(/^\s*/)?.[0]?.length ?? 0;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      end = i;
      continue;
    }
    const nextIndent = line.match(/^\s*/)?.[0]?.length ?? 0;
    if (nextIndent <= indent && /^\s*(func|class|class_name|const|var|let)\b/.test(line)) break;
    end = i;
  }

  return {
    ...anchor,
    startLine: index + 1,
    endLine: Math.max(index + 1, end + 1),
    provider: 'local-symbol-fallback',
  };
}

function normalizeHintAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  if (!['symbol', 'range'].includes(anchor.kind)) return null;
  if (typeof anchor.file !== 'string' || !anchor.file.trim()) return null;
  if (anchor.kind === 'symbol' && (typeof anchor.symbol !== 'string' || !anchor.symbol.trim())) return null;
  return structuredClone(anchor);
}

function resultHints(result) {
  const payload = result?.result ?? result ?? {};
  const items = payload?.interfaceRealizations;
  if (!Array.isArray(items)) return new Map();
  const map = new Map();
  for (const item of items) {
    if (!item || typeof item.interfaceId !== 'string' || !Array.isArray(item.anchors)) continue;
    const anchors = item.anchors.map(normalizeHintAnchor).filter(Boolean);
    if (anchors.length) map.set(item.interfaceId, anchors);
  }
  return map;
}

function verificationHints(result) {
  const payload = result?.result ?? result ?? {};
  const items = payload?.interfaceVerifications;
  if (!Array.isArray(items)) return new Map();
  const map = new Map();
  for (const item of items) {
    if (!item || typeof item.interfaceId !== 'string') continue;
    const anchors = Array.isArray(item.anchors)
      ? item.anchors.map(normalizeHintAnchor).filter(Boolean)
      : [];
    map.set(item.interfaceId, {
      evidence: Array.isArray(item.evidence) ? structuredClone(item.evidence) : [],
      anchors,
    });
  }
  return map;
}

function reviewerHints(result) {
  const payload = result?.result ?? result ?? {};
  const items = payload?.interfaceReviews;
  if (!Array.isArray(items)) return new Map();
  return new Map(items
    .filter(item => item && typeof item.interfaceId === 'string')
    .map(item => [item.interfaceId, structuredClone(item)]));
}

function ownerForTask(artifactRoot, taskId) {
  const contracts = loadBoundaryContracts(artifactRoot, 'feature');
  for (const [featureId, contract] of contracts) {
    const featureTask = (contract.featureTasks ?? []).find(task => task.id === taskId);
    if (featureTask) return { featureId, contract, featureTask };
  }
  return null;
}

async function validateAnchor({ workspace, codeIntelligence, anchor, observedCommit }) {
  const absolute = resolve(workspace, anchor.file);
  if (!existsSync(absolute)) {
    return { ok: false, anchor: { ...anchor, status: 'BROKEN' }, reason: 'FILE_MISSING' };
  }

  const hash = sha256File(absolute);
  if (anchor.fileHash === hash && anchor.status === 'VALID') {
    return {
      ok: true,
      anchor: { ...anchor, observedCommit: observedCommit ?? anchor.observedCommit ?? null },
      reason: 'HASH_UNCHANGED',
    };
  }

  let resolved = null;
  if (anchor.kind === 'symbol') {
    if (codeIntelligence?.resolveSymbol) {
      try {
        resolved = await codeIntelligence.resolveSymbol({
          file: anchor.file,
          symbol: anchor.symbol,
        });
      } catch {
        resolved = null;
      }
    }
    if (!resolved) resolved = localResolveSymbol(workspace, anchor);
    if (!resolved) {
      return {
        ok: false,
        anchor: { ...anchor, fileHash: hash, observedCommit, status: 'BROKEN' },
        reason: 'SYMBOL_UNRESOLVED',
      };
    }
  } else {
    const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
    if (!Number.isInteger(anchor.startLine) || !Number.isInteger(anchor.endLine)
      || anchor.startLine < 1 || anchor.endLine < anchor.startLine || anchor.endLine > lines.length) {
      return {
        ok: false,
        anchor: { ...anchor, fileHash: hash, observedCommit, status: 'BROKEN' },
        reason: 'RANGE_INVALID',
      };
    }
    resolved = anchor;
  }

  return {
    ok: true,
    anchor: {
      ...anchor,
      ...resolved,
      fileHash: hash,
      observedCommit,
      status: 'VALID',
    },
    reason: anchor.kind === 'symbol' ? 'SYMBOL_RESOLVED' : 'RANGE_VALID',
  };
}

function writeContract(artifactRoot, featureId, contract) {
  const { featureDir } = ensureInterfaceArtifactLayout(artifactRoot);
  const file = join(featureDir, `${featureId}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(contract, null, 2) + '\n');
  renameSync(tmp, file);
}

export async function sealDeveloperInterfaces({
  artifactRoot,
  workspace,
  task,
  result = null,
  codeIntelligence = null,
}) {
  const owner = ownerForTask(artifactRoot, task.id);
  if (!owner) return { required: false, ok: true, reason: 'NO_CANONICAL_FEATURE_TASK' };

  const requiredInterfaceIds = owner.featureTask.interfaceIds ?? [];
  if (requiredInterfaceIds.length === 0) {
    return { required: false, ok: true, reason: 'FEATURE_TASK_HAS_NO_INTERFACE_IDS' };
  }

  const knownInterfaces = new Set((owner.contract.interfaces ?? []).map(entry => entry.id));
  for (const interfaceId of requiredInterfaceIds) {
    if (!knownInterfaces.has(interfaceId)) {
      return {
        required: true,
        ok: false,
        featureId: owner.featureId,
        interfaceId,
        reason: 'UNKNOWN_REQUIRED_INTERFACE',
      };
    }
  }

  const hints = resultHints(result);
  const bindings = new Map(
    (owner.contract.bindings ?? []).map(binding => [binding.interfaceId, structuredClone(binding)])
  );
  for (const [interfaceId, anchors] of hints) {
    if (!requiredInterfaceIds.includes(interfaceId)) continue;
    const existing = bindings.get(interfaceId) ?? {
      interfaceId,
      realizationAnchors: [],
      verificationAnchors: [],
    };
    existing.realizationAnchors = anchors;
    bindings.set(interfaceId, existing);
  }

  const observedCommit = headCommit(workspace);
  const sealed = [];
  const failures = [];

  for (const interfaceId of requiredInterfaceIds) {
    const binding = bindings.get(interfaceId);
    if (!binding || !Array.isArray(binding.realizationAnchors) || binding.realizationAnchors.length === 0) {
      failures.push({ interfaceId, reason: 'MISSING_REALIZATION_BINDING' });
      continue;
    }

    const nextAnchors = [];
    let validCount = 0;
    for (const anchor of binding.realizationAnchors) {
      const checked = await validateAnchor({
        workspace,
        codeIntelligence,
        anchor,
        observedCommit,
      });
      nextAnchors.push(checked.anchor);
      if (checked.ok) validCount += 1;
    }
    binding.realizationAnchors = nextAnchors;
    bindings.set(interfaceId, binding);

    if (validCount === 0) failures.push({ interfaceId, reason: 'NO_VALID_REALIZATION_ANCHOR' });
    else sealed.push({ interfaceId, validAnchors: validCount });
  }

  owner.contract.bindings = [...bindings.values()].sort((a, b) =>
    a.interfaceId.localeCompare(b.interfaceId)
  );
  writeContract(artifactRoot, owner.featureId, owner.contract);

  return {
    required: true,
    ok: failures.length === 0,
    featureId: owner.featureId,
    sealed,
    failures,
    observedCommit,
  };
}


export async function sealTesterInterfaces({
  artifactRoot,
  workspace,
  task,
  result = null,
  codeIntelligence = null,
}) {
  if (result?.outcome && result.outcome !== 'PASS') {
    return { required: false, ok: true, reason: 'TESTER_DID_NOT_CLAIM_PASS' };
  }

  let owner = ownerForTask(artifactRoot, task.id);
  if (!owner) return { required: false, ok: true, reason: 'NO_CANONICAL_FEATURE_TASK' };
  const requiredInterfaceIds = owner.featureTask.interfaceIds ?? [];
  if (requiredInterfaceIds.length === 0) {
    return { required: false, ok: true, reason: 'FEATURE_TASK_HAS_NO_INTERFACE_IDS' };
  }

  const realizationSeal = await sealDeveloperInterfaces({
    artifactRoot,
    workspace,
    task,
    result: null,
    codeIntelligence,
  });
  if (realizationSeal.required && !realizationSeal.ok) {
    return {
      required: true,
      ok: false,
      featureId: owner.featureId,
      repairRole: 'developer',
      failures: realizationSeal.failures.map(failure => ({
        ...failure,
        reason: `REALIZATION_${failure.reason}`,
      })),
    };
  }

  owner = ownerForTask(artifactRoot, task.id);
  const hints = verificationHints(result);
  const bindings = new Map(
    (owner.contract.bindings ?? []).map(binding => [binding.interfaceId, structuredClone(binding)])
  );
  const observedCommit = headCommit(workspace);
  const failures = [];
  const sealed = [];

  for (const interfaceId of requiredInterfaceIds) {
    const hint = hints.get(interfaceId);
    if (!hint || hint.evidence.length === 0) {
      failures.push({ interfaceId, reason: 'MISSING_INTERFACE_VERIFICATION_EVIDENCE' });
      continue;
    }

    let validAnchors = 0;
    if (hint.anchors.length > 0) {
      const binding = bindings.get(interfaceId) ?? {
        interfaceId,
        realizationAnchors: [],
        verificationAnchors: [],
      };
      const nextAnchors = [];
      for (const anchor of hint.anchors) {
        const checked = await validateAnchor({
          workspace,
          codeIntelligence,
          anchor,
          observedCommit,
        });
        nextAnchors.push(checked.anchor);
        if (checked.ok) validAnchors += 1;
      }
      binding.verificationAnchors = nextAnchors;
      bindings.set(interfaceId, binding);
      if (validAnchors === 0) {
        failures.push({ interfaceId, reason: 'NO_VALID_VERIFICATION_ANCHOR' });
        continue;
      }
    }

    sealed.push({
      interfaceId,
      evidenceCount: hint.evidence.length,
      validAnchors,
    });
  }

  owner.contract.bindings = [...bindings.values()].sort((a, b) =>
    a.interfaceId.localeCompare(b.interfaceId)
  );
  writeContract(artifactRoot, owner.featureId, owner.contract);

  return {
    required: true,
    ok: failures.length === 0,
    featureId: owner.featureId,
    repairRole: failures.some(failure => failure.reason.startsWith('REALIZATION_'))
      ? 'developer'
      : 'tester',
    sealed,
    failures,
    observedCommit,
  };
}

export async function sealReviewerInterfaces({
  artifactRoot,
  workspace,
  task,
  result = null,
  codeIntelligence = null,
}) {
  if (result?.outcome && result.outcome !== 'PASS') {
    return { required: false, ok: true, reason: 'REVIEWER_DID_NOT_CLAIM_PASS' };
  }

  const owner = ownerForTask(artifactRoot, task.id);
  if (!owner) return { required: false, ok: true, reason: 'NO_CANONICAL_FEATURE_TASK' };
  const requiredInterfaceIds = owner.featureTask.interfaceIds ?? [];
  if (requiredInterfaceIds.length === 0) {
    return { required: false, ok: true, reason: 'FEATURE_TASK_HAS_NO_INTERFACE_IDS' };
  }

  const realizationSeal = await sealDeveloperInterfaces({
    artifactRoot,
    workspace,
    task,
    result: null,
    codeIntelligence,
  });
  if (realizationSeal.required && !realizationSeal.ok) {
    return {
      required: true,
      ok: false,
      featureId: owner.featureId,
      repairRole: 'developer',
      failures: realizationSeal.failures.map(failure => ({
        ...failure,
        reason: `REALIZATION_${failure.reason}`,
      })),
    };
  }

  const testerResult = [...(task.history ?? [])].reverse().find(
    entry => entry?.type === 'ROLE_RESULT' && entry?.role === 'tester'
  ) ?? null;
  const testerSeal = await sealTesterInterfaces({
    artifactRoot,
    workspace,
    task,
    result: testerResult,
    codeIntelligence,
  });
  if (testerSeal.required && !testerSeal.ok) {
    return {
      required: true,
      ok: false,
      featureId: owner.featureId,
      repairRole: testerSeal.repairRole ?? 'tester',
      failures: testerSeal.failures,
    };
  }

  const reviews = reviewerHints(result);
  const failures = [];
  const sealed = [];
  for (const interfaceId of requiredInterfaceIds) {
    const review = reviews.get(interfaceId);
    if (!review) {
      failures.push({ interfaceId, reason: 'MISSING_INTERFACE_REVIEW' });
      continue;
    }
    if (review.status !== 'APPROVED') {
      failures.push({
        interfaceId,
        reason: 'INTERFACE_REVIEW_NOT_APPROVED',
        status: review.status ?? null,
      });
      continue;
    }
    sealed.push({ interfaceId, status: 'APPROVED' });
  }

  return {
    required: true,
    ok: failures.length === 0,
    featureId: owner.featureId,
    repairRole: 'reviewer',
    sealed,
    failures,
  };
}

export async function sealRoleInterfaces({
  role,
  ...args
}) {
  if (role === 'developer') return sealDeveloperInterfaces(args);
  if (role === 'tester') return sealTesterInterfaces(args);
  if (role === 'reviewer') return sealReviewerInterfaces(args);
  return { required: false, ok: true, reason: 'ROLE_HAS_NO_INTERFACE_SEAL' };
}


export function resolveAnchorStatically({ workspace, anchor, maxLines = 120 }) {
  const absolute = resolve(workspace, anchor.file);
  if (!existsSync(absolute)) {
    return { ok: false, reason: 'FILE_MISSING' };
  }
  const fileHash = sha256File(absolute);
  let resolved = anchor;
  if (anchor.kind === 'symbol') {
    resolved = localResolveSymbol(workspace, anchor);
    if (!resolved) return { ok: false, reason: 'SYMBOL_UNRESOLVED', fileHash };
  }
  if (!Number.isInteger(resolved.startLine) || !Number.isInteger(resolved.endLine)) {
    return { ok: false, reason: 'RANGE_UNRESOLVED', fileHash };
  }
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  if (resolved.startLine < 1 || resolved.endLine < resolved.startLine || resolved.endLine > lines.length) {
    return { ok: false, reason: 'RANGE_INVALID', fileHash };
  }
  const end = Math.min(resolved.endLine, resolved.startLine + Math.max(1, maxLines) - 1);
  return {
    ok: true,
    fileHash,
    range: {
      startLine: resolved.startLine,
      endLine: resolved.endLine,
      truncated: end < resolved.endLine,
    },
    snippet: lines.slice(resolved.startLine - 1, end)
      .map((text, index) => ({ line: resolved.startLine + index, text })),
  };
}
