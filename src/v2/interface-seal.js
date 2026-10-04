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
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
}

function localResolveSymbol(workspace, anchor) {
  const absolute = resolve(workspace, anchor.file);
  if (!existsSync(absolute)) return null;
  const lines = readFileSync(absolute, 'utf8').split(/\\r?\\n/);
  const leaf = String(anchor.symbol ?? '').split('.').at(-1);
  if (!leaf) return null;

  const patterns = [
    new RegExp(`^\\\\s*func\\\\s+${escapeRegExp(leaf)}\\\\s*\\\\(`),
    new RegExp(`^\\\\s*(?:class|class_name)\\\\s+${escapeRegExp(leaf)}\\\\b`),
    new RegExp(`^\\\\s*(?:const|var|let)\\\\s+${escapeRegExp(leaf)}\\\\b`),
  ];
  const index = lines.findIndex(line => patterns.some(pattern => pattern.test(line)));
  if (index < 0) return null;

  let end = index;
  const indent = lines[index].match(/^\\s*/)?.[0]?.length ?? 0;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      end = i;
      continue;
    }
    const nextIndent = line.match(/^\\s*/)?.[0]?.length ?? 0;
    if (nextIndent <= indent && /^\\s*(func|class|class_name|const|var|let)\\b/.test(line)) break;
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
    const lines = readFileSync(absolute, 'utf8').split(/\\r?\\n/);
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
  writeFileSync(tmp, JSON.stringify(contract, null, 2) + '\\n');
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
