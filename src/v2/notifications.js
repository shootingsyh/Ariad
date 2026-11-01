import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Append-only human-attention notification stream. Whenever a task
// transitions INTO a state where a human must act (NEEDS_HUMAN or
// SYSTEM_BLOCKED), the store appends one JSON line to
// notifications.jsonl beside the project's state DB - inside the
// project's .ariad directory, which the project repo tracks in git,
// so the stream is versioned with the project and survives DB
// generations (state.db -> state2.db keeps the same directory).
// Consumers never rewrite the log: they read with a cursor
// (notifications-cursor.json) and ack by advancing it.

export const HUMAN_ATTENTION_STATES = Object.freeze(['NEEDS_HUMAN', 'SYSTEM_BLOCKED']);

export function notificationsLogPath(storeFile) {
  return join(dirname(storeFile), 'notifications.jsonl');
}

export function notificationsCursorPath(storeFile) {
  return join(dirname(storeFile), 'notifications-cursor.json');
}

const isMemoryStore = storeFile => storeFile === ':memory:';

export function readNotifications(storeFile) {
  if (isMemoryStore(storeFile)) return [];
  const path = notificationsLogPath(storeFile);
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a torn final line is ignored, never fatal */ }
  }
  return records;
}

export function readNotificationCursor(storeFile) {
  if (isMemoryStore(storeFile)) return 0;
  const path = notificationsCursorPath(storeFile);
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(parsed?.lastReadSeq) ? parsed.lastReadSeq : 0;
  } catch {
    return 0;
  }
}

export function writeNotificationCursor(storeFile, lastReadSeq) {
  const cursor = { lastReadSeq, updatedAt: new Date().toISOString() };
  if (isMemoryStore(storeFile)) return cursor;
  writeFileSync(notificationsCursorPath(storeFile), `${JSON.stringify(cursor, null, 2)}\n`);
  return cursor;
}

export function listUnreadNotifications(storeFile) {
  const cursor = readNotificationCursor(storeFile);
  return readNotifications(storeFile).filter(record => record.seq > cursor);
}

// The payload a human needs in order to act: what the role submitted
// when it parked the task. Scan the task history backwards for the
// newest entry carrying a summary.
export function summarizeForNotification(task) {
  const history = Array.isArray(task?.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && typeof entry.summary === 'string' && entry.summary) {
      return {
        summary: entry.summary,
        questions: Array.isArray(entry.questions) ? entry.questions.filter(q => typeof q === 'string') : [],
      };
    }
  }
  return { summary: '', questions: [] };
}

export function appendNotification(storeFile, { projectId, taskId, taskTitle = '', state, task = null }) {
  if (isMemoryStore(storeFile)) return null;
  const existing = readNotifications(storeFile);
  const seq = (existing.at(-1)?.seq ?? 0) + 1;
  const { summary, questions } = task ? summarizeForNotification(task) : { summary: '', questions: [] };
  const record = { seq, ts: new Date().toISOString(), projectId, taskId, taskTitle, kind: state, summary, questions };
  appendFileSync(notificationsLogPath(storeFile), `${JSON.stringify(record)}\n`);
  return record;
}

// Store hook, called after a task mutation has committed. Appends
// exactly one notification per transition INTO a human-attention
// state: further updates while staying in the state do not
// re-notify; leaving and re-entering notifies again. A notification
// failure must never break task mutation, so errors are swallowed.
export function notifyHumanAttentionTransition(storeFile, { projectId, task, fromState }) {
  try {
    if (!task || !HUMAN_ATTENTION_STATES.includes(task.state)) return null;
    if (fromState === task.state) return null;
    return appendNotification(storeFile, {
      projectId: projectId ?? task.projectId,
      taskId: task.id,
      taskTitle: task.title ?? '',
      state: task.state,
      task,
    });
  } catch {
    return null;
  }
}
