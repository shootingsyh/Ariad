function latestDurableDeliveryGate(store, projectId) {
  let latest = null;
  for (const task of store.listTasks(projectId)) {
    for (const entry of task.history ?? []) {
      if (entry?.type !== 'DELIVERY_GATE' || typeof entry?.enabled !== 'boolean') continue;
      latest = entry;
    }
  }
  return latest;
}

function plannerPmTask(task) {
  return task?.scope === 'control'
    && task?.stage === 'pm'
    && task?.input?.purpose === 'PLANNER_PM_REVIEW';
}

function hasHumanDecision(task) {
  return (task?.history ?? []).some(entry => entry?.type === 'HUMAN_DECISION');
}

function hasExecutedDelivery(tasks) {
  return tasks.some(task =>
    task?.scope === 'delivery'
    && ['DONE', 'WORKING', 'RESULT_READY', 'WAITING_REPLAN', 'SYSTEM_BLOCKED'].includes(task.state)
  );
}

export function inferTakeoverReviewRequired(store, projectId) {
  const project = store.getProject(projectId);
  if (!project || project.mode !== 'TAKEOVER') return false;
  const tasks = store.listTasks(projectId);
  if (tasks.some(task => plannerPmTask(task) && hasHumanDecision(task))) return false;
  if (hasExecutedDelivery(tasks)) return false;
  return true;
}

export function ensureTakeoverReviewState(store, projectId) {
  let project = store.getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  if (typeof project.takeoverReviewRequired === 'boolean') return project;
  project = store.updateProject(projectId, project.version, {
    takeoverReviewRequired: inferTakeoverReviewRequired(store, projectId),
  });
  return project;
}

export function takeoverReviewPending(store, projectId) {
  const project = store.getProject(projectId);
  if (!project || project.mode !== 'TAKEOVER') return false;
  if (typeof project.takeoverReviewRequired === 'boolean') return project.takeoverReviewRequired;
  return inferTakeoverReviewRequired(store, projectId);
}

export function completeTakeoverReview(store, projectId) {
  let project = ensureTakeoverReviewState(store, projectId);
  if (project.takeoverReviewRequired !== false) {
    project = store.updateProject(projectId, project.version, { takeoverReviewRequired: false });
  }
  return project;
}

function obsoleteTakeoverRecoveryExists(store, projectId) {
  return store.listTasks(projectId).some(task =>
    (task.history ?? []).some(entry =>
      entry?.type === 'SYSTEM_RECOVERY'
      && entry?.reason === 'OBSOLETE_REPEAT_TAKEOVER_GATE'
    )
  );
}

export function repairLegacyRecoveredTakeoverDeliveryGate(store, projectId) {
  const project = ensureTakeoverReviewState(store, projectId);
  if (project.mode !== 'TAKEOVER' || project.takeoverReviewRequired !== false) {
    return { repaired: false, deliveryEnabled: project.deliveryEnabled === true, reason: 'takeover-review-pending-or-not-takeover' };
  }
  if (!obsoleteTakeoverRecoveryExists(store, projectId)) {
    return { repaired: false, deliveryEnabled: project.deliveryEnabled === true, reason: 'no-obsolete-takeover-recovery' };
  }

  const durableGate = latestDurableDeliveryGate(store, projectId);
  if (!durableGate) {
    return { repaired: false, deliveryEnabled: project.deliveryEnabled === true, reason: 'no-durable-delivery-gate' };
  }

  if (project.deliveryEnabled === durableGate.enabled) {
    return { repaired: false, deliveryEnabled: project.deliveryEnabled === true, reason: 'already-matches-durable-gate' };
  }

  const updated = store.updateProject(projectId, project.version, {
    deliveryEnabled: durableGate.enabled,
  });
  return {
    repaired: true,
    deliveryEnabled: updated.deliveryEnabled === true,
    reason: 'restored-latest-durable-delivery-gate',
  };
}

export function recoverObsoleteTakeoverHumanGates(store, projectId) {
  const project = ensureTakeoverReviewState(store, projectId);
  if (project.takeoverReviewRequired !== false) return [];

  const recovered = [];
  for (const task of store.listTasks(projectId)) {
    if (task.state !== 'NEEDS_HUMAN' || !plannerPmTask(task) || hasHumanDecision(task)) continue;
    const accepted = [...(task.history ?? [])].reverse().find(
      entry => entry?.type === 'ROLE_RESULT'
        && entry?.role === 'pm'
        && entry?.outcome === 'PLAN_ACCEPTED'
    );
    if (!accepted) continue;

    store.appendTaskHistory(task.id, task.version, {
      type: 'SYSTEM_RECOVERY',
      role: 'pm',
      reason: 'OBSOLETE_REPEAT_TAKEOVER_GATE',
      summary: 'Recovered a repeated TAKEOVER human gate after the project takeover review had already been satisfied.',
      at: new Date().toISOString(),
    }, {
      state: 'DONE',
      execution: null,
    });

    // The repeated gate is invalid and must not overwrite the last durable
    // delivery decision. Restore the most recent persisted DELIVERY_GATE
    // rather than reading startDelivery from this obsolete PM result.
    const durableGate = latestDurableDeliveryGate(store, projectId);
    if (durableGate) {
      const current = store.getProject(projectId);
      if (current?.deliveryEnabled !== durableGate.enabled) {
        store.updateProject(projectId, current.version, { deliveryEnabled: durableGate.enabled });
      }
    }
    recovered.push(task.id);
  }
  return recovered;
}
