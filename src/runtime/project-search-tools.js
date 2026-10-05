import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

function walkJson(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJson(path, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path);
  }
  return out;
}

function contains(value, needle) {
  return JSON.stringify(value).toLowerCase().includes(needle);
}

export function interfaceSearch(workspace, query, { limit = 20 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) throw new Error('interface search query is required');
  const root = join(workspace, '.ariad', 'artifacts', 'planner', 'interfaces');
  const hits = [];
  for (const file of walkJson(root)) {
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const nodeId = doc.nodeId ?? null;
    for (const entry of doc.interfaces ?? []) {
      if (!contains(entry, needle) && !String(entry.id ?? '').toLowerCase().includes(needle)) continue;
      hits.push({
        nodeId,
        interfaceId: entry.id ?? null,
        kind: entry.kind ?? null,
        visibility: entry.visibility ?? null,
        contract: entry.contract ?? null,
        realization: entry.realization ?? [],
        verification: entry.verification ?? [],
        source: relative(workspace, file),
      });
      if (hits.length >= limit) return hits;
    }
    for (const entry of doc.imports ?? []) {
      if (!contains(entry, needle)) continue;
      hits.push({
        nodeId,
        interfaceId: entry.interfaceId ?? null,
        importFrom: entry.fromNodeId ?? null,
        purpose: entry.purpose ?? null,
        source: relative(workspace, file),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

function rgHits(workspace, needle, limit) {
  try {
    const stdout = execFileSync('rg', [
      '--json', '--smart-case', '--hidden',
      '--glob', '!.git/**', '--glob', '!.ariad/pi/**',
      '--glob', '!.ariad/memory.db*',
      '--max-count', String(Math.max(1, Math.min(limit, 100))),
      needle, '.',
    ], { cwd: workspace, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const hits = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'match') continue;
      const data = event.data;
      hits.push({
        file: String(data.path?.text ?? '').replace(/^\.\//, '') || null,
        line: data.line_number ?? null,
        text: String(data.lines?.text ?? '').trimEnd(),
        submatches: (data.submatches ?? []).map(m => ({ text: m.match?.text ?? '', start: m.start, end: m.end })),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  } catch (error) {
    if (error?.status === 1) return [];
    throw new Error(`code_search failed: ${error?.message ?? String(error)}`);
  }
}

function declarationRegex(symbol) {
  const escaped = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    '\\b(?:class|function|interface|type|enum|struct|def|fn|func|const|let|var)\\s+' + escaped +
      '\\b|\\b' + escaped + '\\s*[:=]\\s*(?:async\\s*)?(?:function|\\(|class)',
    'i',
  );
}

export function codeSearch(workspace, query, { limit = 40, mode = 'text' } = {}) {
  const needle = String(query ?? '').trim();
  if (!needle) throw new Error('code search query is required');
  const hits = rgHits(workspace, needle, mode === 'symbol' ? Math.max(limit * 3, limit) : limit);
  if (mode !== 'symbol') return hits.slice(0, limit);

  const declaration = declarationRegex(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactWord = new RegExp('\\b' + escaped + '\\b');
  const rank = { declaration: 0, 'symbol-reference': 1, text: 2 };
  return hits
    .map(hit => ({
      ...hit,
      matchKind: declaration.test(hit.text)
        ? 'declaration'
        : (exactWord.test(hit.text) ? 'symbol-reference' : 'text'),
    }))
    .sort((a, b) =>
      rank[a.matchKind] - rank[b.matchKind]
      || String(a.file).localeCompare(String(b.file))
      || (a.line ?? 0) - (b.line ?? 0)
    )
    .slice(0, limit);
}
