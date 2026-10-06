import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveAnchorStatically,
} from '../../v2/interface-seal.js';

export { resolveAnchorStatically };

function snippetForRange(workspace, anchor, range) {
  const absolute = resolve(workspace, anchor.file);
  if (!existsSync(absolute)) return null;
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  return lines.slice(range.startLine - 1, range.endLine).map((text, index) => ({
    line: range.startLine + index,
    text,
  }));
}

export async function resolveAnchor({ workspace, anchor, codeIntelligence = null }) {
  if (anchor.kind === 'symbol' && codeIntelligence) {
    try {
      let resolved = null;
      if (typeof codeIntelligence.resolveSymbol === 'function') {
        resolved = await codeIntelligence.resolveSymbol({
          file: anchor.file,
          symbol: anchor.symbol,
        });
      } else if (typeof codeIntelligence.findSymbol === 'function') {
        const absolute = resolve(workspace, anchor.file);
        const symbol = await codeIntelligence.findSymbol(
          absolute,
          String(anchor.symbol).split('.').pop(),
        );
        const range = symbol?.selectionRange ?? symbol?.range ?? null;
        if (range) {
          resolved = {
            file: anchor.file,
            startLine: range.start.line + 1,
            endLine: range.end.line + 1,
          };
        }
      }
      if (resolved?.startLine && resolved?.endLine) {
        return {
          ok: true,
          anchor,
          absolute: resolve(workspace, anchor.file),
          range: {
            startLine: resolved.startLine,
            endLine: resolved.endLine,
          },
          snippet: snippetForRange(workspace, anchor, resolved),
          resolver: 'lsp',
        };
      }
    } catch {
      // Fall through to the deterministic file-local resolver.
    }
  }
  return {
    ...resolveAnchorStatically({ workspace, anchor }),
    resolver: 'static',
  };
}

export async function sealInterface({
  workspace,
  featureId,
  interfaceContract,
  codeIntelligence = null,
  requireVerification = false,
}) {
  const realizationAnchors = interfaceContract.realization
    ?? interfaceContract.realizationAnchors
    ?? [];
  const verificationAnchors = interfaceContract.verification
    ?? interfaceContract.verificationAnchors
    ?? [];

  const realization = [];
  for (const anchor of realizationAnchors) {
    realization.push(await resolveAnchor({ workspace, anchor, codeIntelligence }));
  }
  const verification = [];
  for (const anchor of verificationAnchors) {
    verification.push(await resolveAnchor({ workspace, anchor, codeIntelligence }));
  }

  const failures = [
    ...realization.filter(item => !item.ok),
    ...(requireVerification ? verification.filter(item => !item.ok) : []),
  ];
  if (realizationAnchors.length === 0) {
    failures.push({ ok: false, reason: 'NO_REALIZATION_BINDING' });
  }
  if (requireVerification && verificationAnchors.length === 0) {
    failures.push({ ok: false, reason: 'NO_VERIFICATION_BINDING' });
  }

  return {
    ok: failures.length === 0,
    featureId,
    interfaceId: interfaceContract.id ?? interfaceContract.interfaceId,
    realization,
    verification,
    failures,
  };
}

export async function sealTaskInterfaces({
  workspace,
  featureContracts,
  featureIds,
  codeIntelligence = null,
  requireVerification = false,
}) {
  const seals = [];
  for (const featureId of featureIds) {
    const feature = featureContracts.get(featureId);
    if (!feature) continue;
    for (const iface of feature.interfaces ?? []) {
      const binding = (feature.bindings ?? []).find(item => item.interfaceId === iface.id);
      seals.push(await sealInterface({
        workspace,
        featureId,
        interfaceContract: {
          ...iface,
          realizationAnchors: binding?.realizationAnchors ?? [],
          verificationAnchors: binding?.verificationAnchors ?? [],
        },
        codeIntelligence,
        requireVerification,
      }));
    }
  }
  return { ok: seals.every(seal => seal.ok), seals };
}
