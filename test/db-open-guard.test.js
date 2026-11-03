import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { VersionedStore } from '../src/v2/versioned-store.js';
import { RoleResultDispatcher } from '../src/v2/role-result-dispatcher.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ariad-dbguard-')); }

test('a non-existent path still creates a fresh store', () => {
  const dir = tmp();
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  store.createProject({ id: 'p1' });
  assert.equal(store.getProject('p1').id, 'p1');
  store.db.close();
  const vs = new VersionedStore(join(dir, 'other.db'));
  vs.initProject('p1');
  assert.equal(vs.projectId, 'p1');
  vs.close();
});

test('an existing 0-byte store hard-fails with STORE_DB_EMPTY and records an incident', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  writeFileSync(file, '');
  assert.throws(() => new SQLiteV2Store(file), /STORE_DB_EMPTY/);
  assert.throws(() => new VersionedStore(file), /STORE_DB_EMPTY/);
  const incidents = readFileSync(join(dir, 'db-incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(incidents.length >= 2);
  assert.ok(incidents.every(i => i.code === 'STORE_DB_EMPTY' && i.file === 'state.db'));
});

test('an existing corrupt (non-SQLite) store hard-fails with STORE_DB_CORRUPT', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  writeFileSync(file, Buffer.alloc(4096, 0x41));
  assert.throws(() => new SQLiteV2Store(file), /STORE_DB_CORRUPT/);
  assert.throws(() => new VersionedStore(file), /STORE_DB_CORRUPT/);
  const incidents = readFileSync(join(dir, 'db-incidents.jsonl'), 'utf8');
  assert.match(incidents, /STORE_DB_CORRUPT/);
});

test('a healthy existing store reopens fine (guard is transparent)', () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  const store = new SQLiteV2Store(file);
  store.createProject({ id: 'p1' });
  store.db.close();
  const reopened = new SQLiteV2Store(file);
  assert.equal(reopened.getProject('p1').id, 'p1');
  reopened.db.close();
  assert.equal(existsSync(join(dir, 'db-incidents.jsonl')), false);
});

test('dispatcher refuses to accept results when the store is corrupt', async () => {
  const dir = tmp();
  const file = join(dir, 'state.db');
  writeFileSync(file, Buffer.alloc(4096, 0x42));
  const rawDb = new DatabaseSync(file);
  const incidents = [];
  let transitionCalled = false;
  const task = {
    id: 't1', projectId: 'p1', state: 'RESULT_READY', stage: 'developer', taskKind: 'FEATURE_TASK',
    history: [{ type: 'ROLE_RESULT', role: 'developer', outcome: 'PASS' }],
  };
  const store = {
    db: rawDb,
    listTasks: () => [structuredClone(task)],
    recordIncident: (incident) => { incidents.push(incident); },
  };
  const roles = { get: () => ({ transition: async () => { transitionCalled = true; throw new Error('must not be called'); } }) };
  const dispatcher = new RoleResultDispatcher({ store, roles });
  await dispatcher.advanceResults('p1');
  assert.equal(transitionCalled, false);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, 'RESULT_ACCEPTANCE_REFUSED_DB_CORRUPT');
  rawDb.close();
});
