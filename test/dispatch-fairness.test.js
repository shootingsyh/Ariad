import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTasks, orderCandidates, runnableSince, STARVED_AFTER_MS } from '../src/v2/dispatch-fairness.js';

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-11-14T18:00:00.000Z');

test('runnableSince: dependency-free task can start when it first entered the spec', () => {
  const task = { id: 't', state: 'READY', dependsOn: [] };
  assert.deepEqual(
    runnableSince(task, new Map([['t', task]]), now - 2 * HOUR),
    { runnableSinceMs: now - 2 * HOUR, blockedBy: [] },
  );
});

test('runnableSince: waits for the latest prerequisite completion', () => {
  const dep = { id: 'd', state: 'DONE', updatedAt: new Date(now - HOUR).toISOString() };
  const task = { id: 't', state: 'READY', dependsOn: ['d'] };
  assert.deepEqual(
    runnableSince(task, new Map([['d', dep], ['t', task]]), now - 3 * HOUR),
    { runnableSinceMs: now - HOUR, blockedBy: [] },
  );
});

test('runnableSince: names unfinished prerequisites instead of a time', () => {
  const dep = { id: 'd', state: 'READY' };
  const task = { id: 't', state: 'READY', dependsOn: ['d'] };
  assert.deepEqual(
    runnableSince(task, new Map([['d', dep], ['t', task]]), now - 3 * HOUR),
    { runnableSinceMs: null, blockedBy: ['d'] },
  );
});

test('runnableSince: a task that is not READY cannot start', () => {
  assert.deepEqual(
    runnableSince({ id: 't', state: 'WORKING', dependsOn: [] }, new Map(), now),
    { runnableSinceMs: null, blockedBy: [] },
  );
});

test('auditTasks: a runnable task past the threshold with no history is starved', () => {
  const tasks = [{ id: 'old', state: 'READY', dependsOn: [], history: [] }];
  const [entry] = auditTasks(tasks, { nowMs: now, firstSeenAt: new Map([['old', now - 2 * HOUR]]), thresholdMs: HOUR });
  assert.equal(entry.starved, true);
  assert.equal(entry.waitMs, 2 * HOUR);
});

test('auditTasks: a task that already started is never starved', () => {
  const tasks = [{
    id: 'old', state: 'READY', dependsOn: [],
    history: [{ type: 'ROLE_RESULT', at: new Date(now - 90 * 60 * 1000).toISOString() }],
  }];
  const [entry] = auditTasks(tasks, { nowMs: now, firstSeenAt: new Map([['old', now - 2 * HOUR]]), thresholdMs: HOUR });
  assert.equal(entry.starved, false);
});

test('auditTasks: fresh runnable work and finished work are not starved', () => {
  const tasks = [
    { id: 'fresh', state: 'READY', dependsOn: [], history: [] },
    { id: 'done', state: 'DONE', dependsOn: [], history: [] },
  ];
  const audit = auditTasks(tasks, { nowMs: now, firstSeenAt: new Map([['fresh', now - 10 * 60 * 1000]]), thresholdMs: HOUR });
  assert.deepEqual(audit.map(entry => [entry.id, entry.starved]), [['fresh', false]]);
});

test('orderCandidates: starved work goes first, oldest first, the rest keep their order', () => {
  const mk = id => ({ task: { id } });
  const auditById = new Map([
    ['a', { starved: false }],
    ['b', { starved: true, runnableSinceMs: now - 3 * HOUR }],
    ['c', { starved: true, runnableSinceMs: now - 2 * HOUR }],
    ['d', { starved: false }],
  ]);
  assert.deepEqual(
    orderCandidates([mk('a'), mk('b'), mk('c'), mk('d')], auditById).map(c => c.task.id),
    ['b', 'c', 'a', 'd'],
  );
});

test('STARVED_AFTER_MS is one hour', () => {
  assert.equal(STARVED_AFTER_MS, HOUR);
});
