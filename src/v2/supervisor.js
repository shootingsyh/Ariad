import { isAdhocAnalysis, isDiagnosisEligible, openDiagnosisGate } from './control-task-policy.js';
import { applyTaskEvent } from './state-machine.js';
import { isNonretryableProviderFailure } from './nonretryable-provider-failure.js';
import { isTransientProviderFailure, transientRetryCooldownMs, transientWindowExpired } from './transient-provider-failure.js';
import {
  autoCarryExhausted, diagnosisAttemptsExhausted, diagnosisDecidedAwaitingResume,
  diagnosisTaskView, systemIncidentFromHistory,
} from './system-block-diagnosis.js';
import { milestoneResultTransition } from './milestone-result-executor.js';

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
  constructor({ store, providers, resources, incidentSink = null, startDiagnosisSession = null }) {
    this.store = store;
    this.providers = providers;
    this.resources = resources;
    this.incidentSink = incidentSink;
    this.startDiagnosisSession = startDiagnosisSession;
  }

  recover(projectId) {
    this.resources.recover(this.store.listTasksByStates(projectId, ['WORKING']));
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
    for (const task of this.store.listTasksByStates(projectId, ['WORKING'])) {
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
      // Transient provider unavailability does not consume an attempt and
      // parks the task in a cooldown instead of burning the failure
      // ladder; see transient-provider-failure.js for the rationale.
      const transient = isTransientProviderFailure(failure);
      const consumeAttempt = transient ? false : status?.consumeAttempt !== false;
      const blocked = transient
        ? transientWindowExpired(current)
        : isNonretryableProviderFailure(failure) || (consumeAttempt && systemFailureCount(current) >= 2);
      this.store.appendTaskHistory(task.id, current.version, {
        type: 'SYSTEM_INTERRUPTION',
        role: task.stage,
        failure,
        provenance: structuredClone(execution?.provenance ?? null),
        protocolVersion: execution?.protocolVersion ?? null,
        projectVersion: execution?.projectVersion ?? null,
        consumeAttempt,
        ...(transient ? { transient: true } : {}),
        executionContext: structuredClone(status?.executionContext ?? null),
        ...(status?.restartOrphan === true ? { restartOrphan: true } : {}),
        at: incident.at,
      }, applyTaskEvent(
        current,
        blocked ? 'BLOCK_SYSTEM_FAILURE' : 'RETRY_SYSTEM_FAILURE',
        {
          execution: null,
          retryNotBefore: transient && !blocked
            ? new Date(Date.now() + transientRetryCooldownMs()).toISOString()
            : null,
        },
      ));
      this.resources.release(task.id);
    }
    // A blocked task cannot escalate itself into the project debugger,
    // so the supervisor runs the debugger session itself (see
    // system-block-diagnosis.js): it polls the one active diagnosis
    // run, applies its verdict to the blocked task, and starts a
    // session for the next blocked task when the slot is free.
    try {
      await this.#diagnosisSweep(projectId, incidents);
    } catch { /* the diagnosis sweep must never break supervision; the next audit retries */ }
    return { incidents };
  }

  // ---- system-block diagnosis (supervisor-managed sessions) ----

  async #diagnosisSweep(projectId, incidents) {
    // Everything the sweep acts on lives on a SYSTEM_BLOCKED task: the
    // live diagnosis run, an open operator gate and every eligibility
    // predicate. Fetch that state only - the unfiltered list this
    // replaced re-parsed the whole ledger three times per audit.
    let blocked = this.store.listTasksByStates(projectId, ['SYSTEM_BLOCKED']);
    const running = blocked.find(task => task.diagnosisRun?.externalId);
    if (running) {
      const slotFreed = await this.#pollDiagnosisRun(running, incidents);
      if (!slotFreed) return;
      // The verdict may have moved the polled task; re-read before
      // choosing the next blocked task, as the old per-step fetches did.
      blocked = this.store.listTasksByStates(projectId, ['SYSTEM_BLOCKED']);
    }
    if (!this.startDiagnosisSession) return;
    // An open operator gate occupies the diagnosis slot: the operator
    // is already being asked about one block.
    if (blocked.some(task => openDiagnosisGate(task))) return;
    for (const task of blocked) {
      if (!isDiagnosisEligible(task)) continue;
      if (diagnosisDecidedAwaitingResume(task)) continue;
      if (autoCarryExhausted(task)) continue;
      if (diagnosisAttemptsExhausted(task)) continue;
      await this.#startDiagnosisRun(projectId, task, incidents);
      return;
    }
  }

  async #startDiagnosisRun(projectId, task, incidents) {
    const started = (task.history ?? [])
      .filter(entry => entry?.type === 'SYSTEM_DIAGNOSIS_STARTED').length;
    const attemptId = `${projectId}:${task.id}:project_debugger:diagnosis:${started + 1}`;
    let handle;
    try {
      handle = await this.startDiagnosisSession({ projectId, task, attemptId });
    } catch (error) {
      incidents.push(await this.#incident(task, `SYSTEM_DIAGNOSIS_START_FAILED: ${error?.message ?? String(error)}`));
      return;
    }
    if (!handle?.externalId) {
      incidents.push(await this.#incident(task, 'SYSTEM_DIAGNOSIS_START_FAILED: provider returned no run handle'));
      return;
    }
    const current = this.store.getTask(task.id);
    this.store.appendTaskHistory(task.id, current.version, {
      type: 'SYSTEM_DIAGNOSIS_STARTED', role: 'project_debugger', attemptId,
      at: new Date().toISOString(),
    }, {
      ...current,
      diagnosisRun: {
        provider: handle.provider, externalId: handle.externalId, attemptId,
        completionProtocol: handle.completionProtocol ?? 'provider_terminal',
        startedAt: new Date().toISOString(),
      },
    });
  }

  // Returns true when the diagnosis slot is free afterwards (the run
  // was moot or stale and its handle was dropped); false while a live
  // session owns the slot or a verdict was applied this audit.
  async #pollDiagnosisRun(task, incidents) {
    const run = task.diagnosisRun;
    const incidentAt = systemIncidentFromHistory(task).at;
    // The block went away under the session (an operator resume
    // recovered the task), or the task blocked again after this run
    // started: the run's verdict would describe a stale block. Drop
    // the handle; a fresh session is started for the current block.
    if (task.state !== 'SYSTEM_BLOCKED' || (incidentAt && run.startedAt && incidentAt > run.startedAt)) {
      const current = this.store.getTask(task.id);
      this.store.updateTask(task.id, current.version, { ...current, diagnosisRun: null });
      this.resources.release(task.id);
      return true;
    }
    let status;
    try {
      const provider = this.providers.get(run.provider);
      status = await provider.poll({ externalId: run.externalId, taskId: task.id });
    } catch (error) {
      status = { state: 'LOST', failure: error?.message ?? String(error) };
    }
    if (status?.state === 'RUNNING' || status?.state === 'QUEUED') return false;
    if (status?.state === 'COMPLETED') {
      const fresh = this.store.getTask(task.id);
      const submitted = [...(fresh?.history ?? [])].reverse().find(entry =>
        entry?.type === 'ROLE_RESULT' && entry?.source === 'role_result_tool'
        && entry?.attemptId === run.attemptId && entry?.role === 'project_debugger');
      if (submitted) {
        await this.#applyDiagnosisVerdict(fresh, submitted, incidents);
        return false;
      }
      if (run.completionProtocol === 'role_result_tool') {
        await this.#diagnosisRunDied(fresh ?? task, 'MISSING_ROLE_RESULT_TOOL', incidents);
        return false;
      }
      // Provider-terminal completion: the verdict rides on the poll
      // status itself, exactly as it does for a dispatched task.
      await this.#applyDiagnosisVerdict(fresh ?? task, {
        outcome: status.outcome ?? 'PASS',
        summary: status.summary ?? '',
        result: status.result ?? null,
      }, incidents);
      return false;
    }
    await this.#diagnosisRunDied(task, status?.failure ?? status?.state ?? 'EXECUTION_LOST', incidents);
    return false;
  }

  async #diagnosisRunDied(task, failure, incidents) {
    incidents.push(await this.#incident(task, failure));
    const current = this.store.getTask(task.id);
    this.store.appendTaskHistory(task.id, current.version, {
      type: 'SYSTEM_DIAGNOSIS_ATTEMPT', role: 'project_debugger',
      attemptId: task.diagnosisRun?.attemptId ?? null, failure,
      at: new Date().toISOString(),
    }, { ...current, diagnosisRun: null });
    this.resources.release(task.id);
  }

  async #applyDiagnosisVerdict(task, result, incidents) {
    let next = null;
    try {
      next = milestoneResultTransition(diagnosisTaskView(task), result, {});
    } catch { next = null; }
    const current = this.store.getTask(task.id);
    if (next?.blockedRoute) {
      const route = next.blockedRoute;
      const updated = this.store.appendTaskHistory(task.id, current.version, route.history, {
        ...current, ...(route.patch ?? {}), diagnosisRun: null,
      });
      if (next.planningRequest) {
        this.store.enqueuePlanningRequest({
          id: next.planningRequest.id, projectId: task.projectId,
          request: next.planningRequest.request,
        });
      }
      this.resources.release(task.id);
      return updated;
    }
    if (next?.transitionHistory?.type === 'SYSTEM_DIAGNOSIS') {
      // Operator-required verdict: the gate entry lands on the blocked
      // task itself. It stays SYSTEM_BLOCKED; the project waits at
      // NEEDS_HUMAN until the operator decides, and the resume after
      // the decision performs the recovery.
      const updated = this.store.appendTaskHistory(task.id, current.version, next.transitionHistory, {
        ...current, diagnosisRun: null,
      });
      this.resources.release(task.id);
      return updated;
    }
    incidents.push(await this.#incident(task, 'SYSTEM_DIAGNOSIS_UNROUTABLE_VERDICT'));
    const updated = this.store.appendTaskHistory(task.id, current.version, {
      type: 'SYSTEM_DIAGNOSIS_ATTEMPT', role: 'project_debugger',
      attemptId: task.diagnosisRun?.attemptId ?? null, failure: 'SYSTEM_DIAGNOSIS_UNROUTABLE_VERDICT',
      at: new Date().toISOString(),
    }, { ...current, diagnosisRun: null });
    this.resources.release(task.id);
    return updated;
  }
}
