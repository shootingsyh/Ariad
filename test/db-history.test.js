import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { DbHistory, restoreDbHistory, ensureDbHistoryHook } from '../src/v2/db-history.js';
import { registerBeforeReopenHook } from '../src/v2/store-connection.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ariad-history-')); }

function setup(opts = {}) {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  store.createProject({ id: 'p1' });
  store.db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)');
  const historyDir = join(dir, 'db-history');
  const history = new DbHistory({
    dbFile: file,
    historyDir,
    getHandle: () => { try { return store.db; } catch { return null; } },
    anchor: 'storage:test',
    ...opts,
  });
  return { dir, file, store, history, historyDir };
}

function addNote(store, body) {
  store.db.prepare('INSERT INTO notes(body) VALUES (?)').run(body);
}
function liveNotes(store) {
  return store.db.prepare('SELECT body FROM notes ORDER BY id').all().map(r => r.body);
}
function restoredNotes(historyDir, dir) {
  const target = join(dir, 'restored.db');
  const res = restoreDbHistory(historyDir, target);
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    return { res, rows: db.prepare('SELECT body FROM notes ORDER BY id').all().map(r => r.body) };
  } finally { db.close(); }
}
function csFiles(historyDir) {
  const csDir = join(historyDir, 'cs');
  return existsSync(csDir) ? readdirSync(csDir).filter(n => n.endsWith('.bin')).sort() : [];
}

test('first capture creates the baseline; later captures chain changesets that replay to the live state', () => {
  const { dir, store, history, historyDir } = setup();
  addNote(store, 'A'); // before any capture: absorbed by the baseline
  const first = history.capture();
  assert.equal(first.rotated, true);
  assert.ok(existsSync(join(historyDir, 'baseline.db')));
  assert.equal(JSON.parse(readFileSync(join(historyDir, 'manifest.json'), 'utf8')).anchor, 'storage:test');
  addNote(store, 'B');
  const c1 = history.capture();
  assert.equal(c1.captured, true);
  assert.equal(c1.file, 'cs/000001.bin');
  addNote(store, 'C');
  const c2 = history.capture();
  assert.equal(c2.file, 'cs/000002.bin');
  const { res, rows } = restoredNotes(historyDir, dir);
  assert.equal(res.changesetsApplied, 2);
  assert.deepEqual(rows, ['A', 'B', 'C']);
  assert.deepEqual(rows, liveNotes(store));
  store.close();
});

test('an empty capture is a no-op, and restore refuses an existing target', () => {
  const { dir, store, history, historyDir } = setup();
  history.capture(); // baseline
  addNote(store, 'A');
  history.capture();
  const again = history.capture();
  assert.equal(again.captured, false);
  assert.equal(again.empty, true);
  assert.equal(csFiles(historyDir).length, 1);
  const target = join(dir, 'restored.db');
  restoreDbHistory(historyDir, target);
  assert.throws(() => restoreDbHistory(historyDir, target), /DB_HISTORY_TARGET_EXISTS/);
  store.close();
});

test('chain limits rotate the baseline and restart the chain', () => {
  const { dir, store, history, historyDir } = setup({ maxChainFiles: 1 });
  history.capture(); // baseline
  addNote(store, 'A');
  history.capture(); // chain: 1 file, at the limit but not past it
  addNote(store, 'B');
  const c = history.capture(); // chain would exceed -> rotate after capture
  assert.equal(c.rotated, true);
  const manifest = JSON.parse(readFileSync(join(historyDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.chainFiles, 0);
  assert.equal(manifest.nextSeq, 1);
  assert.deepEqual(csFiles(historyDir), []);
  const { rows } = restoredNotes(historyDir, dir);
  assert.deepEqual(rows, ['A', 'B']);
  store.close();
});

test('a handle replaced without a flush rotates instead of chaining (gap)', () => {
  const { dir, store, history, historyDir } = setup();
  history.capture(); // baseline
  addNote(store, 'B');
  history.capture(); // cs/000001
  addNote(store, 'C'); // pending in the session, never captured
  store.db.close(); // handle dies with its session; no flush hook here
  store.reopen(new Error('handle died'));
  addNote(store, 'D');
  const c = history.capture();
  assert.equal(c.rotated, true); // gap detected: baseline re-anchored
  const { rows } = restoredNotes(historyDir, dir);
  assert.deepEqual(rows, ['B', 'C', 'D']); // baseline absorbed everything
  store.close();
});

test('flushForReopen drains the pending changeset for its own file only', () => {
  const { store, history, historyDir } = setup();
  history.capture(); // baseline
  addNote(store, 'B');
  history.flushForReopen({ file: '/somewhere/else.db', key: 'other' });
  assert.deepEqual(csFiles(historyDir), []); // not our file: untouched
  history.flushForReopen({ file: history.dbFile, key: 'ours' });
  assert.deepEqual(csFiles(historyDir), ['000001.bin']);
  store.close();
});

test('the pre-reopen flush keeps the chain intact when the file dies under a live handle', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  store.createProject({ id: 'p1' });
  store.db.exec('PRAGMA cache_size = 10'); // force file reads: no hiding in the page cache
  store.db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)');
  const historyDir = join(dir, 'db-history');
  const history = new DbHistory({
    dbFile: file, historyDir,
    getHandle: () => { try { return store.db; } catch { return null; } },
    anchor: 'storage:test',
  });
  const off = registerBeforeReopenHook(box => history.flushForReopen(box));
  try {
    history.capture(); // baseline
    const body = 'x'.repeat(500);
    for (let i = 0; i < 300; i++) addNote(store, body + i);
    history.capture(); // cs/000001: the 300 notes
    addNote(store, 'last-before-crash'); // pending in the session
    // Fold the WAL into the main file first: with frames still in the
    // WAL, a truncated main file stays readable and there is nothing
    // to detect - the incident signature is tail pages that exist
    // nowhere else.
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    // The 2026-11-25 signature: the file loses its tail pages under
    // the live handle.
    const buf = readFileSync(file);
    writeFileSync(file, buf.subarray(0, buf.length - 2 * 4096));
    assert.throws(() => store.reopen(new Error('io error')), /STORE_DB_CORRUPT/);
    // The flush ran before the close: the pending note is in the chain.
    assert.deepEqual(csFiles(historyDir), ['000001.bin', '000002.bin']);
    const { res, rows } = restoredNotes(historyDir, dir);
    assert.equal(res.changesetsApplied, 2);
    assert.equal(rows.length, 301);
    assert.equal(rows[300], 'last-before-crash');
  } finally {
    off();
    try { store.close(); } catch { /* faulted latch: close still releases */ }
  }
});

test('ensureDbHistoryHook appends the managed block exactly once', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  const existing = '#!/bin/bash\necho legacy gate\n';
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), existing);
  const first = ensureDbHistoryHook({ workspace: dir, projectId: 'demo', cliFile: '/opt/ariad/cli.js' });
  assert.equal(first.installed, true);
  const content = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.ok(content.startsWith(existing));
  assert.ok(content.includes('project db-capture demo'));
  assert.ok(content.includes('git add -- .ariad/db-history'));
  const second = ensureDbHistoryHook({ workspace: dir, projectId: 'demo', cliFile: '/opt/ariad/cli.js' });
  assert.equal(second.installed, false);
  assert.equal(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), content);
});
