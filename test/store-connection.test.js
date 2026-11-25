import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { VersionedTaskStore } from '../src/v2/versioned-task-store.js';
import { SQLiteReconcileSignal } from '../src/v2/sqlite-reconcile-signal.js';
import { openGuardedDatabase } from '../src/v2/db-open-guard.js';
import {
  acquireStoreConnection, ensureStoreHandle, releaseStoreConnection,
  reopenStoreConnection, snapshotStoreFiles, restoreStoreFiles,
} from '../src/v2/store-connection.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ariad-conn-')); }

function corruptSchemaPage(file) {
  // Scribble over page 1's b-tree page header (offset 100): the schema
  // tree's cell bookkeeping is destroyed, which integrity_check always
  // reports (free-space corruption would go unnoticed by design).
  const buf = readFileSync(file);
  for (let i = 100; i < 108 && i < buf.length; i++) buf[i] = 0xff;
  writeFileSync(file, buf);
}

function truncateTail(file, pages = 2) {
  // The 2026-11-25 incident signature: the header still claims pages
  // the file no longer has.
  const buf = readFileSync(file);
  writeFileSync(file, buf.subarray(0, buf.length - pages * 4096));
}

test('two stores over one file share a single connection handle', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const a = new SQLiteV2Store(file);
  const b = new VersionedStore(file);
  assert.equal(a.db, b.db);
  a.createProject({ id: 'p1' });
  b.initProject('p1');
  assert.equal(b.projectId, 'p1');
  const shared = a.db;
  b.close();
  // Closing one holder must not pull the handle from under the other.
  assert.equal(a.getProject('p1').id, 'p1');
  assert.equal(a.db, shared);
  a.close();
  // Last release really closes: a new store gets a fresh handle.
  const c = new SQLiteV2Store(file);
  assert.notEqual(c.db, shared);
  assert.equal(c.getProject('p1').id, 'p1');
  c.close();
});

test('the reconcile signal shares the store connection and counts its writes', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  const signal = new SQLiteReconcileSignal(file);
  assert.equal(signal.db, store.db);
  const before = signal.read();
  store.createProject({ id: 'p1' });
  assert.ok(signal.read() > before);
  signal.close();
  assert.equal(store.getProject('p1').id, 'p1');
  store.close();
});

test('reopen over a dead handle swaps the handle for every holder and snapshots first', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const runtime = new SQLiteV2Store(file);
  runtime.createProject({ id: 'p1' });
  const facade = new VersionedTaskStore(runtime);
  const before = runtime.db;
  runtime.db.close(); // the handle died underneath the holders
  facade.reopen(new Error('simulated stale view'));
  assert.notEqual(runtime.db, before);
  assert.equal(facade.versioned.db, runtime.db);
  assert.equal(runtime.getProject('p1').id, 'p1');
  const snaps = readdirSync(join(dir, 'snapshots')).filter(n => n.startsWith('state-prereopen-'));
  assert.ok(snaps.length >= 1);
  facade.close();
  runtime.close();
});

test('a handle killed under the holders fails loudly, and reopen recovers every holder', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const a = new SQLiteV2Store(file);
  const b = new VersionedStore(file);
  a.createProject({ id: 'p1' });
  b.initProject('p1');
  a.db.close(); // the cached handle dies underneath both stores
  assert.throws(() => a.getProject('p1'));
  a.reopen(new Error('simulated dead handle'));
  assert.equal(a.getProject('p1').id, 'p1');
  assert.equal(b.db, a.db);
  assert.equal(b.projectId, 'p1');
  b.close();
  a.close();
});

test('guarded open refuses a corrupt file without touching its bytes', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  store.createProject({ id: 'p1' });
  store.close();
  corruptSchemaPage(file);
  const bytesBefore = readFileSync(file);
  assert.throws(() => openGuardedDatabase(file), /STORE_DB_CORRUPT/);
  assert.deepEqual(readFileSync(file), bytesBefore);
  // A read-only check on a cold WAL file may leave an empty -wal/-shm
  // index shell behind; it must never create or destroy a single frame.
  if (existsSync(file + '-wal')) {
    assert.equal(readFileSync(file + '-wal').length, 0);
  }
});

test('reopen over a corrupt file restores the snapshot and latches faulted', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const seed = new SQLiteV2Store(file);
  seed.createProject({ id: 'p1' });
  seed.close();
  truncateTail(file);
  const box = acquireStoreConnection(file);
  assert.throws(() => reopenStoreConnection(box, new Error('probe')), /STORE_DB_CORRUPT/);
  // Latched: further use throws the recorded failure without new opens.
  assert.throws(() => ensureStoreHandle(box, 0, null), /STORE_DB_CORRUPT/);
  assert.throws(() => reopenStoreConnection(box), /STORE_DB_CORRUPT/);
  releaseStoreConnection(box);
  // After the last holder releases, a fresh construction re-verifies
  // from scratch (and still refuses: the file is still corrupt).
  assert.throws(() => new SQLiteV2Store(file), /STORE_DB_CORRUPT/);
});

test('snapshot/restore round-trips the db trio byte-for-byte', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  writeFileSync(file, 'main-bytes');
  writeFileSync(file + '-wal', 'wal-bytes');
  const snap = snapshotStoreFiles(file, 'unittest');
  assert.ok(snap && existsSync(snap) && existsSync(snap + '-wal'));
  writeFileSync(file, 'changed');
  writeFileSync(file + '-wal', 'changed-wal');
  assert.equal(restoreStoreFiles(file, snap), true);
  assert.equal(readFileSync(file, 'utf8'), 'main-bytes');
  assert.equal(readFileSync(file + '-wal', 'utf8'), 'wal-bytes');
});

test('reopen is skipped while the shared handle proves healthy', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  store.createProject({ id: 'p1' });
  const before = store.db;
  store.reopen(new Error('simulated transient stale view'));
  assert.equal(store.db, before); // same handle: no close, no reopen
  assert.equal(store.db.prepare('SELECT 1 AS one').get().one, 1);
  const snapDir = join(dir, 'snapshots');
  const snaps = existsSync(snapDir) ? readdirSync(snapDir).filter(n => n.startsWith('state-prereopen-')) : [];
  assert.deepEqual(snaps, []); // and no snapshot was taken either
  // Contrast: once the handle is really dead, reopen does replace it.
  store.db.close();
  store.reopen(new Error('handle actually dead'));
  assert.notEqual(store.db, before);
  assert.equal(store.db.prepare('SELECT 1 AS one').get().one, 1);
  store.close();
});
