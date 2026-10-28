#!/usr/bin/env node
// Offline one-time migration: canonicalize v2_tasks rows to the converged
// task schema (taskKind is the only type field). Reads the live DB
// read-only and writes only to a NEW copy, never to the live DB.
//
//   node scripts/migrate-task-kinds.mjs --live-db DB                 (preflight)
//   node scripts/migrate-task-kinds.mjs --live-db DB --apply --out NEW_DB
//
// The legacy type derivation lives here, and only here: the runtime store
// trusts taskKind exactly as stored and never interprets input.taskKind,
// the lowercase 'feature'/'integration' spellings, or the scope fallback.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { TASK_KINDS } from '../src/v2/control-task-policy.js';

function legacyTaskKind(task) {
  const kind = task?.taskKind ?? task?.input?.taskKind;
  if (kind === 'feature') return TASK_KINDS.FEATURE_TASK;
  if (kind === 'integration') return TASK_KINDS.INTEGRATION_TASK;
  if (kind != null) return kind;
  return task?.scope === 'control'
    ? (task?.stage === 'project_debugger' ? TASK_KINDS.DIAGNOSTIC : TASK_KINDS.PLANNING)
    : TASK_KINDS.MILESTONE_TASK;
}

function canonicalize(task) {
  const input = { ...(task.input ?? {}) };
  const hadShadow = 'taskKind' in input || 'executionMode' in input
    || 'executorType' in task || 'scope' in task;
  delete input.taskKind;
  delete input.executionMode;
  const kind = legacyTaskKind(task);
  const next = { ...task, input, taskKind: kind };
  delete next.executorType;
  delete next.scope;
  return { next, kind, hadShadow, changed: kind !== task.taskKind || hadShadow };
}

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const source = arg('--live-db');
const output = arg('--out');
const apply = args.includes('--apply');
if (!source || (apply && !output)) {
  console.error('Usage: node scripts/migrate-task-kinds.mjs --live-db DB [--apply --out NEW_DB]');
  process.exitCode = 2;
} else {
  const live = realpathSync(source);
  const db = new DatabaseSync(live, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, data_json FROM v2_tasks').all();
    const report = { total: rows.length, alreadyCanonical: 0, restamped: {}, shadowFieldsStripped: 0 };
    const updates = [];
    for (const row of rows) {
      const task = JSON.parse(row.data_json);
      const { next, kind, hadShadow, changed } = canonicalize(task);
      if (hadShadow) report.shadowFieldsStripped += 1;
      if (changed) {
        report.restamped[kind] = (report.restamped[kind] ?? 0) + 1;
        updates.push({ id: row.id, data: next });
      } else {
        report.alreadyCanonical += 1;
      }
    }
    console.log(JSON.stringify({ mode: 'PREFLIGHT', liveDb: live, report }, null, 2));
    if (apply) {
      const out = resolve(output);
      if (out === live || existsSync(out)) throw new Error('output must be a new path, not the live DB');
      mkdirSync(dirname(out), { recursive: true });
      await backup(db, out);
      const copy = new DatabaseSync(out);
      try {
        copy.exec('BEGIN IMMEDIATE');
        const stmt = copy.prepare('UPDATE v2_tasks SET data_json = ? WHERE id = ?');
        for (const u of updates) stmt.run(JSON.stringify(u.data), u.id);
        copy.exec('COMMIT');
      } catch (error) {
        copy.exec('ROLLBACK');
        throw error;
      } finally {
        copy.close();
      }
      console.log(JSON.stringify({ mode: 'MIGRATED_COPY', out, updated: updates.length }, null, 2));
      console.log('Live DB unchanged. Review the copy and arrange a separate, offline activation.');
    }
  } finally {
    db.close();
  }
}
