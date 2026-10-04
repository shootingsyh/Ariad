import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function lineRange(lines, startLine, endLine) {
  return lines.slice(startLine - 1, endLine).map((line, index) => ({
    line: startLine + index,
    text: line,
  }));
}

function gdscriptFunctionRange(lines, symbol) {
  const leaf = String(symbol).split('.').pop();
  const escaped = leaf.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^\\s*(?:static\\s+)?func\\s+' + escaped + '\\s*\\(');
  const start = lines.findIndex(line => pattern.test(line));
  if (start < 0) return null;
  const indent = (lines[start].match(/^\s*/) ?? [''])[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) { end += 1; continue; }
    const currentIndent = (line.match(/^\s*/) ?? [''])[0].length;
    if (currentIndent <= indent && /^\s*(?:static\s+)?func\s+/.test(line)) break;
    end += 1;
  }
  return { startLine: start + 1, endLine: Math.max(start + 1, end) };
}

export function resolveAnchorStatically({ workspace, anchor }) {
  const absolute = resolve(workspace, anchor.file);
  if (!existsSync(absolute)) return { ok: false, anchor, reason: 'FILE_MISSING' };
  const content = readFileSync(absolute, 'utf8');
  const lines = content.split(/\r?\n/);
  let range = null;
  if (anchor.kind === 'range') {
    if (anchor.startLine > lines.length || anchor.endLine > lines.length) {
      return { ok: false, anchor, reason: 'RANGE_OUT_OF_BOUNDS', fileHash: sha256(content) };
    }
    range = { startLine: anchor.startLine, endLine: anchor.endLine };
  } else if (anchor.kind === 'symbol') {
    if (absolute.endsWith('.gd')) range = gdscriptFunctionRange(lines, anchor.symbol);
    if (!range) {
      const leaf = String(anchor.symbol).split('.').pop();
      const hit = lines.findIndex(line => line.includes(leaf));
      if (hit >= 0) range = { startLine: hit + 1, endLine: hit + 1 };
    }
    if (!range) return { ok: false, anchor, reason: 'SYMBOL_NOT_FOUND', fileHash: sha256(content) };
  }
  return {
    ok: true, anchor, absolute, fileHash: sha256(content), range,
    snippet: lineRange(lines, range.startLine, range.endLine),
  };
}

export async function resolveAnchor({ workspace, anchor, codeIntelligence = null }) {
  if (anchor.kind === 'symbol' && codeIntelligence) {
    try {
      const absolute = resolve(workspace, anchor.file);
      const symbol = await codeIntelligence.findSymbol(absolute, String(anchor.symbol).split('.').pop());
      const range = symbol?.selectionRange ?? symbol?.range ?? null;
      if (range) {
        const content = readFileSync(absolute, 'utf8');
        const lines = content.split(/\r?\n/);
        const normalized = { startLine: range.start.line + 1, endLine: range.end.line + 1 };
        return {
          ok: true, anchor, absolute, fileHash: sha256(content), range: normalized,
          snippet: lineRange(lines, normalized.startLine, normalized.endLine), resolver: 'lsp',
        };
      }
    } catch {}
  }
  return { ...resolveAnchorStatically({ workspace, anchor }), resolver: 'static' };
}

export async function sealInterface({ workspace, featureId, interfaceContract, codeIntelligence = null, requireVerification = false }) {
  const realization = [];
  for (const anchor of interfaceContract.realization ?? []) {
    realization.push(await resolveAnchor({ workspace, anchor, codeIntelligence }));
  }
  const verification = [];
  for (const anchor of interfaceContract.verification ?? []) {
    verification.push(await resolveAnchor({ workspace, anchor, codeIntelligence }));
  }
  const failures = [
    ...realization.filter(item => !item.ok),
    ...(requireVerification ? verification.filter(item => !item.ok) : []),
  ];
  if ((interfaceContract.realization ?? []).length === 0) failures.push({ ok: false, reason: 'NO_REALIZATION_BINDING' });
  if (requireVerification && (interfaceContract.verification ?? []).length === 0) failures.push({ ok: false, reason: 'NO_VERIFICATION_BINDING' });
  return {
    ok: failures.length === 0, featureId, interfaceId: interfaceContract.id,
    realization, verification, failures,
  };
}

export async function sealTaskInterfaces({ workspace, featureContracts, featureIds, codeIntelligence = null, requireVerification = false }) {
  const seals = [];
  for (const featureId of featureIds) {
    const feature = featureContracts.get(featureId);
    if (!feature) continue;
    for (const iface of feature.interfaces ?? []) {
      seals.push(await sealInterface({ workspace, featureId, interfaceContract: iface, codeIntelligence, requireVerification }));
    }
  }
  return { ok: seals.every(seal => seal.ok), seals };
}
