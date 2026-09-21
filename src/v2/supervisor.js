function submittedRoleToolResult(task, attemptId = task?.execution?.attemptId) {
  if (!attemptId) return null;
  return [...(task?.history ?? [])].reverse().find(
    entry => entry?.type === 'ROLE_RESULT'
      && entry?.source === 'role_result_tool'
      && entry?.attemptId === attemptId
      && entry?.role === task.stage
  ) ?? null;
}

function systemFailureCount(task) {
  let count = 0;
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type === 'ROLE_RESULT') break;
    if (entry?.type === 'SYSTEM_INTERRUPTION') count += 1;
  }
  return count;
}

export class V2Supervisor {
  constructor({ store, providers, resources, incidentSink = null }) {
    this.store = store;
    this.providers = providers;
    this.resources = resources;
    this.incidentSink = incidentSink;
  }

  recover(projectId) {
    this.resources.recover(this.store.listTasks(projectId));
  }

  async #incident(task, failure) {
    const incident = {
      type: 'SYSTEM_INCIDENT',
      projectId: task.projectId,
      taskId: task.id,
      provider: task.execution?.provider ?? null,
      externalId: task.execution?.externalId ?? null,
      failure,
      at: new Date().toISOString(),
    };
    if (this.incidentSink?.record) await this.incidentSink.record(incident);
    else if (typeof this.store.recordIncident === 'function') this.store.recordIncident(incident);
    return incident;
  }

  async audit(projectId) {
    const incidents = [];
    for (const task of this.store.listTasks(projectId)) {
      if (task.state !== 'WORKING') continue;
      const execution = task.execution;

      if (!execution?.provider || !execution?.externalId) {
        const incident = await this.#incident(task, 'MISSING_EXECUTION_HANDLE');
        incidents.push(incident);
        const current = this.store.getTask(task.id);
        this.store.appendTaskHistory(task.id, current.version, {
          type: 'SYSTEM_INTERRUPTION',
          role: task.stage,
          failure: incident.failure,
          consumeAttempt: false,
          uncertainStart: Boolean(task.execution?.attemptId),
          at: incident.at,
        }, {
          state: systemFailureCount(current) >= 2 ? 'SYSTEM_BLOCKED' : 'READY',
          execution: null,
        });
        this.resources.release(task.id);
        continue;
      }

      const provider = this.providers.get(execution.provider);
      let status;
      try {
        status = await provider.poll({ externalId: execution.externalId, taskId: task.id });
      } catch (error) {
        status = { state: 'LOST', failure: error?.message ?? String(error) };
      }

      if (status?.state === 'RUNNING' || status?.state === 'QUEUED') continue;

      const current = this.store.getTask(task.id);

      // The role result tool can commit while waitForRun() is observing the
      // provider's terminal turn. Re-check durable history after polling so a
      // valid sealed result always wins over any prose emitted afterward.
      const postPollSubmittedResult = submittedRoleToolResult(current, execution.attemptId);
      if (postPollSubmittedResult) {
        this.store.updateTask(task.id, current.version, {
          state: 'RESULT_READY',
          execution: null,
          artifacts: [...(current.artifacts ?? []), ...(postPollSubmittedResult.artifacts ?? [])],
        });
        this.resources.release(task.id);
        continue;
      }

      if (status?.state === 'COMPLETED') {
        this.store.appendTaskHistory(task.id, current.version, {
          type: 'ROLE_RESULT',
          role: task.stage,
          outcome: status.outcome ?? 'PASS',
          summary: status.summary ?? '',
          keyPoints: status.keyPoints ?? [],
          artifacts: status.artifacts ?? [],
          result: status.result ?? null,
          completedAt: new Date().toISOString(),
        }, {
          state: 'RESULT_READY',
          execution: null,
          artifacts: [...(current.artifacts ?? []), ...(status.artifacts ?? [])],
        });
        this.resources.release(task.id);
        continue;
      }

      const failure = status?.failure ?? status?.state ?? 'EXECUTION_LOST';
      const incident = await this.#incident(task, failure);
      incidents.push(incident);
      this.store.appendTaskHistory(task.id, current.version, {
        type: 'SYSTEM_INTERRUPTION',
        role: task.stage,
        failure,
        at: incident.at,
      }, {
        state: systemFailureCount(current) >= 2 ? 'SYSTEM_BLOCKED' : 'READY',
        execution: null,
      });
      this.resources.release(task.id);
    }
    return { incidents };
  }
}
