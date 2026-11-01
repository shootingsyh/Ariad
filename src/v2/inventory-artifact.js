// Iteration inventory artifact (2026-10-31): at cutover the system writes
// a plain-file inventory of the previous generation's database - what it
// holds and what its schema looks like - under .ariad/artifacts/inventory/.
// Nothing is imported or seeded into the new database: at the next
// iteration the PM and TL read these files with their normal tools and
// judge for themselves what carries over. This is documentation for
// on-site discovery, not a migration mechanism.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(r => r.name);
}

function dumpTable(db, table, jsonColumns) {
  const rows = db.prepare(`SELECT * FROM "${table}"`).all();
  return rows.map(row => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = jsonColumns.includes(key) && typeof value === 'string' ? (parseJson(value) ?? value) : value;
    }
    return out;
  });
}

function schemaMarkdown(db, tables) {
  const lines = ['# Previous database schema', ''];
  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
    lines.push(`## ${table}`, '');
    for (const col of cols) lines.push(`- ${col.name} (${col.type || 'ANY'}${col.pk ? ', pk' : ''})`);
    lines.push('');
  }
  return lines.join('\n');
}

export function writeInventoryArtifact({ db, workspace, project, oldDbPath, archiveDir = null, now = new Date() }) {
  const relDir = '.ariad/artifacts/inventory';
  const dir = join(workspace, relDir);
  mkdirSync(dir, { recursive: true });
  const tables = tableNames(db);
  const has = name => tables.includes(name);
  const guard = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  // ---- row dumps (tasks trimmed: histories collapse to counts) ----
  const tasks = has('v2_tasks') ? guard(() => dumpTable(db, 'v2_tasks', ['data_json']).map(row => {
    const data = row.data_json && typeof row.data_json === 'object' ? row.data_json : {};
    const { history, execution, ...rest } = data;
    return {
      id: row.id, state: data.state ?? null,
      ...rest,
      historyEntries: Array.isArray(history) ? history.length : 0,
      lastHistoryType: Array.isArray(history) && history.length ? (history[history.length - 1]?.type ?? null) : null,
    };
  }), []) : [];
  const issues = has('v2_issues') ? guard(() => dumpTable(db, 'v2_issues', ['data_json']).map(row => ({
    id: row.id, state: row.state, ...(row.data_json && typeof row.data_json === 'object' ? row.data_json : {}),
  })), []) : [];
  const contracts = has('spec_contracts') ? guard(() => dumpTable(db, 'spec_contracts', ['contract_json'])
    .map(row => row.contract_json && typeof row.contract_json === 'object' ? row.contract_json : row), []) : [];
  const versions = has('spec_versions') ? guard(() => dumpTable(db, 'spec_versions', []), []) : [];
  const legacy = has('legacy_entries') ? guard(() => dumpTable(db, 'legacy_entries', ['payload_json']), []) : [];

  writeFileSync(join(dir, 'SCHEMA.md'), schemaMarkdown(db, tables));
  writeFileSync(join(dir, 'tasks.json'), `${JSON.stringify(tasks, null, 2)}\n`);
  writeFileSync(join(dir, 'issues.json'), `${JSON.stringify(issues, null, 2)}\n`);
  writeFileSync(join(dir, 'contracts.json'), `${JSON.stringify(contracts, null, 2)}\n`);
  if (legacy.length) writeFileSync(join(dir, 'legacy.json'), `${JSON.stringify(legacy, null, 2)}\n`);

  // ---- human/role-readable summary ----
  const delivery = tasks.filter(t => !['PLANNING_TASK'].includes(t.taskKind));
  const byState = {};
  for (const t of delivery) byState[t.state ?? 'UNKNOWN'] = (byState[t.state ?? 'UNKNOWN'] ?? 0) + 1;
  const openIssues = issues.filter(i => !['RESOLVED', 'CLOSED'].includes(i.state));
  let memoryCount = null;
  const memoryDb = join(workspace, '.ariad', 'memory.db');
  if (existsSync(memoryDb)) {
    memoryCount = guard(() => {
      const mdb = new DatabaseSync(memoryDb, { readOnly: true });
      try { return mdb.prepare('SELECT COUNT(*) AS n FROM memories').get().n; } finally { mdb.close(); }
    }, null);
  }
  const lines = [
    `# Previous-generation inventory - ${project.id}`,
    '',
    `Generated ${now.toISOString()} at iteration cutover from ${basename(oldDbPath)}.`,
    'This directory is documentation for the PM and the TL: read it with your normal tools and judge for yourselves what carries into the new version. Nothing here was imported into the new database.',
    archiveDir ? `Full records (histories, payloads) remain in the archived database at ${archiveDir} - read it directly when you need evidence beyond this summary.` : '',
    '',
    '## Project',
    '',
    `goal: ${project.goal ?? '(none recorded)'}`,
    '',
  ];
  if (versions.length) {
    lines.push('## Versions in the previous database', '');
    for (const v of versions) lines.push(`- version ${v.version}: ${v.state}${v.approved_by ? ` (approved by ${v.approved_by})` : ''}`);
    lines.push('');
  }
  lines.push('## Tasks', '', `${delivery.length} delivery tasks: ${Object.entries(byState).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}.`, '');
  const done = delivery.filter(t => t.state === 'DONE');
  if (done.length) {
    lines.push('### Finished (DONE)', '');
    for (const t of done) lines.push(`- \`${t.id}\` - ${t.title ?? '(untitled)'}${t.stage ? ` (${t.stage})` : ''}`);
    lines.push('');
  }
  const notDone = delivery.filter(t => t.state !== 'DONE');
  if (notDone.length) {
    lines.push('### Not finished', '');
    for (const t of notDone) lines.push(`- \`${t.id}\` - ${t.title ?? '(untitled)'} - ${t.state}`);
    lines.push('');
  }
  if (contracts.length) {
    lines.push('## Feature contracts in the previous database', '');
    for (const c of contracts) lines.push(`- \`${c.id}\` - ${c.title ?? '(untitled)'}${c.nodeType ? ` (${c.nodeType})` : ''}`);
    lines.push('');
  }
  lines.push('## Issues', '', `${issues.length} total, ${openIssues.length} open.`, '');
  for (const i of openIssues) lines.push(`- \`${i.id}\` - ${i.title ?? '(untitled)'}`);
  if (openIssues.length) lines.push('');
  if (legacy.length) {
    lines.push('## Distilled legacy record of the generation before', '',
      'The previous database also carried a distilled legacy zone (completion cards, resolved issues, project facts). Its entries are dumped in legacy.json; the summary lines are:', '');
    for (const e of legacy) lines.push(`- ${e.kind}: \`${e.old_id}\`${e.summary ? ` - ${e.summary}` : ''}`);
    lines.push('');
  }
  if (memoryCount != null) lines.push('## Project memory', '', `${memoryCount} curated memories in .ariad/memory.db (the memory store itself carries over untouched).`, '');
  lines.push('## Files', '',
    '- SCHEMA.md - every table and column of the previous database',
    '- tasks.json / issues.json / contracts.json - row dumps (task histories trimmed to counts)',
    ...(legacy.length ? ['- legacy.json - the previous distilled legacy zone, dumped whole'] : ''),
    '');
  writeFileSync(join(dir, 'INVENTORY.md'), lines.join('\n'));

  return {
    dir: relDir,
    tasks: delivery.length,
    done: done.length,
    openIssues: openIssues.length,
    contracts: contracts.length,
    legacyEntries: legacy.length,
  };
}
