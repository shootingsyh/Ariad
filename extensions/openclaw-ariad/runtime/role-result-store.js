import { SQLiteV2Store } from '../../../src/v2/sqlite-store.js';

function projectIdFromAttemptId(attemptId) {
  const separator = String(attemptId ?? '').indexOf(':');
  if (separator <= 0) throw new Error('invalid Ariad attemptId');
  return attemptId.slice(0, separator);
}

export function submitDurableRoleResult({
  manager,
  attemptId,
  role,
  payload,
}) {
  const projectId = projectIdFromAttemptId(attemptId);
  const project = manager.status(projectId);
  const store = new SQLiteV2Store(project.stateDb);
  try {
    let task = store.listTasks(projectId).find(
      item => item?.execution?.attemptId === attemptId
        || (item?.history ?? []).some(entry =>
          entry?.type === 'ROLE_RESULT'
          && entry?.attemptId === attemptId
          && entry?.role === role
          && entry?.source === 'role_result_tool'
        )
    );
    if (!task) throw new Error(`No Ariad task matches attemptId ${attemptId}.`);

    const existing = (task.history ?? []).find(
      entry => entry?.type === 'ROLE_RESULT'
        && entry?.attemptId === attemptId
        && entry?.role === role
        && entry?.source === 'role_result_tool'
    );
    if (existing) {
      return {
        accepted: true,
        sealed: true,
        alreadySubmitted: true,
        projectId,
        taskId: task.id,
        attemptId,
      };
    }

    if (task.stage !== role) {
      throw new Error(`Ariad attempt ${attemptId} belongs to role ${task.stage}, not ${role}.`);
    }
    if (task.state !== 'WORKING') {
      throw new Error(`task ${task.id} is not WORKING`);
    }
    if (task.execution?.attemptId !== attemptId) {
      throw new Error(`stale Ariad attempt ${attemptId}`);
    }

    const entry = {
      type: 'ROLE_RESULT',
      role,
      outcome: payload.outcome,
      summary: payload.summary,
      keyPoints: structuredClone(payload.keyPoints ?? []),
      artifacts: structuredClone(payload.artifacts ?? []),
      result: structuredClone(payload.result ?? null),
      attemptId,
      source: 'role_result_tool',
      completedAt: new Date().toISOString(),
    };

    try {
      task = store.appendTaskHistory(task.id, task.version, entry);
    } catch (error) {
      if (!String(error?.message ?? error).includes('version conflict')) throw error;
      task = store.getTask(task.id);
      const raced = (task?.history ?? []).find(
        item => item?.type === 'ROLE_RESULT'
          && item?.attemptId === attemptId
          && item?.role === role
          && item?.source === 'role_result_tool'
      );
      if (!raced) throw error;
      return {
        accepted: true,
        sealed: true,
        alreadySubmitted: true,
        projectId,
        taskId: task.id,
        attemptId,
      };
    }

    store.checkpoint?.();
    return {
      accepted: true,
      sealed: true,
      alreadySubmitted: false,
      projectId,
      taskId: task.id,
      attemptId,
    };
  } finally {
    store.close();
  }
}
