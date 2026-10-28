import { isAdhocAnalysis } from './control-task-policy.js';
import { applyTaskEvent } from './state-machine.js';
import { isNonretryableProviderFailure } from './nonretryable-provider-failure.js';

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
    if (entry?.type === 'ROLE_RESULT' || entry?.type === 'SYSTEM_RECOVERY') break;
    if (entry?.type === 'SYSTEM_INTERRUPTION' && entry.consumeAttempt !== false) count += 1;
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
      provenance: structuredClone(task.execution?.provenance ?? null),
      protocolVersion: task.execution?.protocolVersion ?? null,
      projectVersion: task.execution?.projectVersion ?? null,
      at: new Date().toISOString(),
    };
    if (this.incidentSink?.record) await this.incidentSink.record(incident);
    else if (typeof this.store.recordIncident === 'function') this.store.recordIncident(incident);
    return incident;
  }

  #acceptSubmittedResult(task, submitted) {
    this.store.updateTask(task.id, task.version, applyTaskEvent(task, 'COMPLETE', {
      execution: null,
      artifacts: [...(task.artifacts ?? []), ...(submitted.artifacts ?? [])],
    }));
    this.resources.release(task.id);
  }

  async audit(projectId, { adhocOnly = false } = {}) {
    const incidents = [];
    for (const task of this.store.listTasks(projectId)) {
      if (task.state !== 'WORKING') continue;
      if (adhocOnly && !isAdhocAnalysis(task)) continue;
      const execution = task.execution;

      if (!execution?.provider || !execution?.externalId) {
        const incident = await this.#incident(task, 'MISSING_EXECUTION_HANDLE');
        incidents.push(incident);
        const current = this.store.getTask(task.id);
        this.store.appendTaskHistory(task.id, current.version, {
          type: 'SYSTEM_INTERRUPTION',
          role: task.stage,
          failure: incident.failure,
          provenance: structuredClone(execution?.provenance ?? null),
          protocolVersion: execution?.protocolVersion ?? null,
          projectVersion: execution?.projectVersion ?? null,
          consumeAttempt: false,
          uncertainStart: Boolean(task.execution?.attemptId),
          executionContext: null,
          at: incident.at,
        }, {
          ...applyTaskEvent(
            current,
            systemFailureCount(current) >= 2 ? 'BLOCK_SYSTEM_FAILURE' : 'RETRY_SYSTEM_FAILURE',
            { execution: null },
          ),
        });
        this.resources.release(task.id);
        continue;
      }

      let provider = null;
      let status;
      try {
        provider = this.providers.get(execution.provider);
      } catch {
        status = {
          state: 'LOST',
          failure: `PROVIDER_UNAVAILABLE_AFTER_RESTART: ${execution.provider}`,
          consumeAttempt: false,
          restartOrphan: true,
        };
      }
      if (!status) {
        try {
          status = await provider.poll({ externalId: execution.externalId, taskId: task.id });
        } catch (error) {
          status = { state: 'LOST', failure: error?.message ?? String(error) };
        }
      }

      if (status?.state === 'RUNNING' || status?.state === 'QUEUED') continue;

      let current = this.store.getTask(task.id);

      const postPollSubmittedResult = submittedRoleToolResult(current, execution.attemptId);
      if (postPollSubmittedResult) {
        this.#acceptSubmittedResult(current, postPollSubmittedResult);
        continue;
      }

      if (status?.state === 'COMPLETED' && execution.completionProtocol === 'role_result_tool') {
        // No supervisor-side rescue branch: a session that finished its
        // work without submitting is recovered inside the provider, which
        // owns the session (same-session resume prompt). By the time a run
        // reports COMPLETED with no submitted result here, that rescue has
        // already had its chance; what remains is a missing result.
        const failure = 'MISSING_ROLE_RESULT_TOOL';
        const incident = await this.#incident(task, failure);
        incidents.push(incident);
        this.store.appendTaskHistory(task.id, current.version, {
          type: 'SYSTEM_INTERRUPTION',
          role: task.stage,
          failure,
          provenance: structuredClone(execution?.provenance ?? null),
          protocolVersion: execution.protocolVersion ?? 'role-result-v2',
          projectVersion: execution?.projectVersion ?? null,
          at: incident.at,
        }, {
          ...applyTaskEvent(
            current,
            systemFailureCount(current) >= 2 ? 'BLOCK_SYSTEM_FAILURE' : 'RETRY_SYSTEM_FAILURE',
            { execution: null },
          ),
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
          executionContext: structuredClone(status.executionContext ?? null),
          completedAt: new Date().toISOString(),
        }, applyTaskEvent(current, 'COMPLETE', {
          execution: null,
          artifacts: [...(current.artifacts ?? []), ...(status.artifacts ?? [])],
        }));
        this.resources.release(task.id);
        continue;
      }

      const failure = status?.failure ?? status?.state ?? 'EXECUTION_LOST';
      const incident = await this.#incident(task, failure);
      incidents.push(incident);
      const consumeAttempt = status?.consumeAttempt !== false;
      const blocked = isNonretryableProviderFailure(failure) || (consumeAttempt && systemFailureCount(current) >= 2);
      this.store.appendTaskHistory(task.id, current.version, {
        type: 'SYSTEM_INTERRUPTION',
        role: task.stage,
        failure,
        provenance: structuredClone(execution?.provenance ?? null),
        protocolVersion: execution?.protocolVersion ?? null,
        projectVersion: execution?.projectVersion ?? null,
        consumeAttempt,
        executionContext: structuredClone(status?.executionContext ?? null),
        ...(status?.restartOrphan === true ? { restartOrphan: true } : {}),
        at: incident.at,
      }, applyTaskEvent(
        current,
        blocked ? 'BLOCK_SYSTEM_FAILURE' : 'RETRY_SYSTEM_FAILURE',
        { execution: null },
      ));
      this.resources.release(task.id);
    }
    return { incidents };
  }
}
