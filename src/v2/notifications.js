import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';

// Human-attention notification table. Whenever a task transitions
// INTO a state where a human must act (NEEDS_HUMAN or
// SYSTEM_BLOCKED), the store appends one row to human_notifications
// in notifications.db beside the project's state DB - inside the
// project's .ariad directory (tracked in git like memory.db), so the
// stream survives state-DB replacement at the fixed state.db path (its own notifications.db keeps
// the same directory). Rows are never edited except for the read
// check: consumers mark what they delivered with read_at, and unread
// is simply read_at IS NULL. SQLite gives transactions, an
// AUTOINCREMENT seq and no torn writes - no log file bookkeeping.

export const HUMAN_ATTENTION_STATES = Object.freeze(['NEEDS_HUMAN', 'SYSTEM_BLOCKED']);

export function notificationsDbPath(storeFile) {
  return join(dirname(storeFile), 'notifications.db');
}

// An ephemeral store (':memory:' in tests) has no directory to keep a
// notification stream in, and resolving one anyway lands a stray
// notifications.db in the process CWD - the suite left one at the repo
// root. Ephemeral stores simply have no notification stream.
function hasNotificationStream(storeFile) {
  return typeof storeFile === 'string' && storeFile.length > 0 && storeFile !== ':memory:';
}

function openNotificationsDb(storeFile) {
  const db = new DatabaseSync(notificationsDbPath(storeFile));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_notifications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      questions_json TEXT NOT NULL DEFAULT '[]',
      read_at TEXT
    );
  `);
  return db;
}

function rowToRecord(row) {
  let questions = [];
  try { questions = JSON.parse(row.questions_json); } catch { /* stored by us; defensive only */ }
  return {
    seq: row.seq,
    ts: row.ts,
    projectId: row.project_id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    kind: row.kind,
    summary: row.summary,
    questions: Array.isArray(questions) ? questions : [],
    read: row.read_at != null,
    readAt: row.read_at,
  };
}

export function readNotifications(storeFile, { unreadOnly = false } = {}) {
  if (!hasNotificationStream(storeFile)) return [];
  let db;
  try {
    db = openNotificationsDb(storeFile);
    const rows = db.prepare(
      `SELECT * FROM human_notifications ${unreadOnly ? 'WHERE read_at IS NULL' : ''} ORDER BY seq`,
    ).all();
    return rows.map(rowToRecord);
  } finally {
    db?.close();
  }
}

export function listUnreadNotifications(storeFile) {
  return readNotifications(storeFile, { unreadOnly: true });
}

// The "check mark": mark every row up to upToSeq as read. Returns how
// many rows were newly checked.
export function ackNotifications(storeFile, upToSeq) {
  if (!hasNotificationStream(storeFile)) return 0;
  let db;
  try {
    db = openNotificationsDb(storeFile);
    const result = db.prepare(
      'UPDATE human_notifications SET read_at = ? WHERE seq <= ? AND read_at IS NULL',
    ).run(new Date().toISOString(), upToSeq);
    return result.changes;
  } finally {
    db?.close();
  }
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
  if (!hasNotificationStream(storeFile)) return null;
  const { summary, questions } = task ? summarizeForNotification(task) : { summary: '', questions: [] };
  let db;
  try {
    db = openNotificationsDb(storeFile);
    const result = db.prepare(
      'INSERT INTO human_notifications (ts, project_id, task_id, task_title, kind, summary, questions_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(new Date().toISOString(), projectId, taskId, taskTitle, state, summary, JSON.stringify(questions));
    return { seq: Number(result.lastInsertRowid), projectId, taskId, taskTitle, kind: state, summary, questions, read: false };
  } finally {
    db?.close();
  }
}

// Store hook, called after a task mutation has committed. Appends
// exactly one row per transition INTO a human-attention state:
// further updates while staying in the state do not re-notify;
// leaving and re-entering notifies again. A notification failure
// must never break task mutation, so errors are swallowed.
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
