import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendNotification,
  readNotifications,
  listUnreadNotifications,
  ackNotifications,
} from '../src/v2/notifications.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';

test('table appends rows with autoincrement seq and read_at is the check mark', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-notif-'));
  const dbFile = join(dir, 'state.db');
  assert.deepEqual(readNotifications(dbFile), []);
  const first = appendNotification(dbFile, {
    projectId: 'P', taskId: 't1', taskTitle: 'First', state: 'NEEDS_HUMAN',
    task: { history: [{ type: 'ROLE_RESULT', summary: 'Human must decide', questions: ['Approve?'] }] },
  });
  const second = appendNotification(dbFile, { projectId: 'P', taskId: 't2', state: 'SYSTEM_BLOCKED', task: { history: [] } });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.summary, 'Human must decide');
  assert.deepEqual(first.questions, ['Approve?']);
  assert.equal(second.summary, '');
  assert.equal(listUnreadNotifications(dbFile).length, 2);

  assert.equal(ackNotifications(dbFile, 1), 1);
  // Acking the same seq again checks nothing new.
  assert.equal(ackNotifications(dbFile, 1), 0);
  const unread = listUnreadNotifications(dbFile);
  assert.equal(unread.length, 1);
  assert.equal(unread[0].taskId, 't2');
  // Rows are never deleted by acking: both remain, first flagged read.
  const all = readNotifications(dbFile);
  assert.equal(all.length, 2);
  assert.equal(all[0].read, true);
  assert.equal(all[1].read, false);
});

test('store appends one notification per transition into a human-attention state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-notif-store-'));
  const dbFile = join(dir, 'state.db');
  const store = new SQLiteV2Store(dbFile);
  store.createProject({ id: 'P', deliveryEnabled: false, deliveryPlanVersion: 1 });
  store.createTask({ taskKind: 'MILESTONE_TASK', id: 'D', projectId: 'P', scope: 'delivery', stage: 'developer', milestoneId: 'V1', title: 'Ship it' });
  assert.deepEqual(readNotifications(dbFile), []);

  const parked = store.updateTask('D', 1, {
    state: 'NEEDS_HUMAN',
    history: [{ type: 'ROLE_RESULT', role: 'pm', summary: 'Requirements need approval', questions: ['Approve the document?'] }],
  });
  let records = readNotifications(dbFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'NEEDS_HUMAN');
  assert.equal(records[0].taskId, 'D');
  assert.equal(records[0].taskTitle, 'Ship it');
  assert.equal(records[0].summary, 'Requirements need approval');
  assert.deepEqual(records[0].questions, ['Approve the document?']);
  assert.equal(records[0].read, false);

  // Staying in the state across further updates does not re-notify.
  const stillParked = store.updateTask('D', parked.version, { state: 'NEEDS_HUMAN' });
  assert.equal(readNotifications(dbFile).length, 1);

  // Leaving and re-entering notifies again.
  const resumed = store.updateTask('D', stillParked.version, { state: 'WORKING' });
  store.updateTask('D', resumed.version, { state: 'SYSTEM_BLOCKED', history: [{ type: 'ROLE_RESULT', summary: 'Escalated' }] });
  records = readNotifications(dbFile);
  assert.equal(records.length, 2);
  assert.equal(records[1].kind, 'SYSTEM_BLOCKED');
  assert.equal(records[1].seq, 2);
});
