import { isNonretryableProviderFailure } from './nonretryable-provider-failure.js';
import { isInTransientCooldown, isTransientProviderFailure, transientRetryCooldownMs, transientWindowExpired } from './transient-provider-failure.js';
import { RoleResultDispatcher } from './role-result-dispatcher.js';
import { graphKey } from './sqlite-store.js';
import { buildExecutionGraph, partitionExecutionGraphs } from './execution-graph.js';
import { auditTasks, orderCandidates } from './dispatch-fairness.js';
import { createNextPlanningBatch, isPlannerTask } from './planner-flow.js';
import { applyTaskEvent } from './state-machine.js';
import { developerTaskPolicyFailure, isApprovalGateTask } from './developer-task-policy.js';
import { controlTaskPolicyFailure, isAdhocAnalysis, queueOfTask, scopeOfTask, TASK_KINDS } from './control-task-policy.js';

// Task-pinned local model (2026-11-20): the capacity-1 'local-llm'
// resource serves one task's whole pipeline at a time. A task that starts
// an attempt on it holds it until the task finishes (DONE/SKIPPED/
// OBSOLETE) or parks (NEEDS_HUMAN/SYSTEM_BLOCKED/BLOCKED); other tasks'
// local stages are not dispatched in between, so a task runs developer ->
// test_engineer -> tester -> reviewer without interleaving. Stages on
// other resources (cloud roles) are unaffected and keep running in
// parallel. The hold is one task id on the project record, re-validated
// against the holder's live state on every tick, so a stale hold can
// never wedge the queue.
export const LOCAL_LLM_RESOURCE = 'local-llm';
const LOCAL_HOLD_ACTIVE_STATES = new Set(['READY', 'WORKING', 'RESULT_READY']);
export function activeLocalLlmHolder(tasks, holderId) {
  if (!holderId) return null;
  const holder = tasks.find(task => task.id === holderId);
  return holder && LOCAL_HOLD_ACTIVE_STATES.has(holder.state) ? holder : null;
}

function topologicalOrder(tasks) {
  const graph = buildExecutionGraph(tasks);
  return graph.order.map(id => graph.byId.get(id));
}

function partitionGraphs(tasks) {
  return partitionExecutionGraphs(tasks).map(({ key, graph }) => ({ key, tasks: graph.tasks }));
}

function systemFailureCount(task) {
  let count = 0;
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type === 'ROLE_RESULT' || entry?.type === 'SYSTEM_RECOVERY') break;
    if (entry?.type === 'SYSTEM_INTERRUPTION' && entry?.consumeAttempt !== false) count += 1;
  }
  return count;
}

export class V2Scheduler {
  constructor({ store, roles, providers, resources, uxReviewEnabled = false }) {
    this.store = store;
    this.roles = roles;
    this.providers = providers;
    this.resources = resources;
    this.resultExecutor = new RoleResultDispatcher({ store, roles, uxReviewEnabled });
  }

  #settlePlanningBatches(projectId) {
    for (const batchId of this.store.listClaimedPlanningBatches(projectId)) {
      const flowId = `planner:${projectId}:${batchId}`;
      const tasks = this.store.listTasksByFlow(projectId, flowId);
      if (tasks.length > 0 && tasks.every(task => ['DONE', 'SKIPPED'].includes(task.state))) {
        this.store.completePlanningBatch(projectId, batchId);
      }
    }
  }

  async tick(projectId, { adhocOnly = false } = {}) {
    const initialProject = this.store.getProject(projectId);
    if (!initialProject) throw new Error(`unknown project: ${projectId}`);
    await this.resultExecutor.advanceResults(projectId, { adhocOnly });
    if (!adhocOnly) {
      this.store.reconcileAssignedIssues?.(projectId);
      this.#settlePlanningBatches(projectId);
    }

    if (!adhocOnly && this.store.hasUnplannedPlanningRequests(projectId)) {
      createNextPlanningBatch({ store: this.store, projectId });
    }

    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);

    // Upgrade pre-split READY tester work to Test Engineer. Never interrupt
    // an in-flight tester; stopped/cancelled work is READY and safe to migrate.
    for (const task of this.store.listTasksByStates(projectId, ['READY'])) {
      if (task.state !== 'READY' || task.stage !== 'tester') continue;
      const approved = [...(task.history ?? [])].reverse().find(h =>
        h.type === 'ROLE_RESULT' && h.role === 'test_engineer' && h.outcome === 'PASS'
      );
      if (approved?.result?.testPlan?.testCases?.length) continue;
      this.store.appendTaskHistory(task.id, task.version, {
        type: 'TEST_ENGINEER_WORKFLOW_UPGRADE',
        fromStage: 'tester', toStage: 'test_engineer', at: new Date().toISOString(),
      }, { stage: 'test_engineer', execution: null });
    }
    const allTasks = this.store.listAllTasks(projectId);
    let localHolder = adhocOnly ? null : activeLocalLlmHolder(allTasks, project.localLlmHolderTaskId);
    // A human-approved PM review remains resumable after its planning request
    // has been marked PLANNED. It must finish the review gate before Delivery
    // may be considered, without reopening unrelated planning work.
    const resumedHumanReview = allTasks.some(task =>
      isPlannerTask(task)
      && task.stage === 'pm'
      && ['READY', 'WORKING', 'RESULT_READY'].includes(task.state)
      && (task.history ?? []).some(entry => entry.type === 'HUMAN_DECISION')
    );
    const planningBlocked = this.store.hasUnplannedPlanningRequests(projectId)
      || this.store.hasActiveNodePlanningJobs(projectId) || resumedHumanReview;
    const deliveryEnabled = project.deliveryEnabled !== false;
    const isUnifiedDiagnostic = task =>
      task.stage === 'project_debugger' && scopeOfTask(task) === 'control' && Boolean(task.input?.blockedTaskId);
    const schedulableTasks = adhocOnly
      ? allTasks.filter(isAdhocAnalysis)
      : planningBlocked
        ? allTasks.filter(task => isPlannerTask(task) || isUnifiedDiagnostic(task) || isAdhocAnalysis(task) || [TASK_KINDS.NODE_PLANNING, TASK_KINDS.GLOBAL_REVIEW].includes(task.taskKind))
        : allTasks.filter(task =>
            (!isPlannerTask(task) || isUnifiedDiagnostic(task))
            && (scopeOfTask(task) !== 'delivery' || deliveryEnabled)
          );
    const candidates = [];
    // Workflow parents are orchestrators, never Pi role sessions.
    // They must not be dispatched until a durable workflow executor owns them.

    for (const { key, graph } of partitionExecutionGraphs(schedulableTasks)) {
      for (const task of graph.tasks) {
        if (!graph.isRunnable(task) || task.taskKind === TASK_KINDS.WORKFLOW) continue;
        // Approval gates are control-plane authorization records, never
        // developer work: the developer-task policy refuses them, and one
        // gate in a plan must not fail the whole tick and block unrelated
        // delivery work. Skip them like workflow parents above.
        if (task.stage === 'developer' && isApprovalGateTask(task)) continue;
        candidates.push({
          task,
          graphKey: key,
          impact: graph.downstreamImpact(task.id),
        });
      }
    }

    // The issue queue drains first: triaged fixes are standalone work
    // parallel to the milestone tree and take dispatch priority over it.
    // Within a queue, prefer work that can unblock the largest unfinished
    // downstream region; stable tie-breakers keep scheduling reproducible.
    const queueRank = candidate => (queueOfTask(candidate.task) === 'issue' ? 0 : 1);
    candidates.sort((a, b) =>
      queueRank(a) - queueRank(b)
      || b.impact - a.impact
      || a.graphKey.localeCompare(b.graphKey)
      || a.task.id.localeCompare(b.task.id)
    );

    // Dispatch fairness (SRPG 2026-11-14): impact-ordered dispatch has no
    // aging, so a runnable low-impact task can starve for a whole iteration
    // while higher-impact work keeps arriving — and nothing alarms. Age
    // starved runnable work to the front of this tick and record each
    // starved task once so project status can name it.
    const fairnessAudit = auditTasks(
      schedulableTasks.filter(task => scopeOfTask(task) === 'delivery'),
      {
        nowMs: Date.now(),
        firstSeenAt: new Map(
          schedulableTasks
            .filter(task => scopeOfTask(task) === 'delivery')
            .map(task => [task.id, this.store.specFirstSeenAt?.(task.id) ?? task.createdAt ?? null])
            .filter(([, at]) => at != null),
        ),
      },
    );
    const fairnessById = new Map(fairnessAudit.map(entry => [entry.id, entry]));
    if (typeof this.store.listIncidents === 'function' && typeof this.store.recordIncident === 'function') {
      const seenStarved = new Set(
        this.store.listIncidents(projectId)
          .filter(incident => incident?.type === 'TASK_DISPATCH_STARVED')
          .map(incident => incident?.taskId),
      );
      for (const entry of fairnessAudit) {
        if (!entry.starved || seenStarved.has(entry.id)) continue;
        this.store.recordIncident({
          projectId,
          taskId: entry.id,
          type: 'TASK_DISPATCH_STARVED',
          runnableSince: new Date(entry.runnableSinceMs).toISOString(),
          waitMs: entry.waitMs,
        });
        seenStarved.add(entry.id);
      }
    }
    const orderedCandidates = orderCandidates(candidates, fairnessById);

    const started = [];

    for (const candidate of orderedCandidates) {
      const task = this.store.getTask(candidate.task.id);
      if (task.state !== 'READY') continue;
      // A task cooling down after a transient provider failure is not
      // dispatchable yet; START clears retryNotBefore when it runs.
      if (isInTransientCooldown(task)) continue;

      // Rebuild the task's graph from fresh durable state before claiming it.
      const graphTasks = task.flowId
        ? this.store.listTasksByFlow(projectId, task.flowId)
        : scopeOfTask(task) === 'delivery'
          ? this.store.listTasksByScope(projectId, 'delivery')
          : this.store.listAllTasks(projectId);
      const sameGraphTasks = graphTasks
        .filter(item => graphKey(item) === graphKey(task));
      const graph = buildExecutionGraph(sameGraphTasks);
      const fresh = graph.byId.get(task.id);
      if (!graph.isRunnable(fresh)) continue;

      const controlPolicyFailure = controlTaskPolicyFailure(task);
      if (controlPolicyFailure) {
        throw new Error(`${controlPolicyFailure}: refusing to dispatch task ${task.id}`);
      }
      const policyFailure = developerTaskPolicyFailure(task, {
        // Legacy pre-v3 hand-created tasks lacked milestone metadata;
        // enforce ownership for projects whose delivery plan is compiled.
        requireMilestone: (project.deliveryPlanVersion ?? 0) > 0,
      });
      if (policyFailure) {
        throw new Error(`${policyFailure}: refusing to dispatch developer task ${task.id}`);
      }

      const role = this.roles.get(task.stage);
      const spec = role.prepare({ project, task });
      if (!spec?.provider) throw new Error(`role ${task.stage} produced no provider`);
      const requirements = spec.resources ?? [];
      // While a task holds the local model, no other task's local stage
      // may start; the holder's own stages and all cloud stages proceed.
      if (!adhocOnly && localHolder && localHolder.id !== task.id && requirements.includes(LOCAL_LLM_RESOURCE)) continue;
      if (!this.resources.claim(requirements, task.id)) continue;

      const priorAttempts = (task.history ?? []).filter(entry =>
        entry?.type === 'ROLE_RESULT'
        || (entry?.type === 'SYSTEM_INTERRUPTION' && entry?.consumeAttempt !== false)
      ).length;
      const attemptId = `${projectId}:${task.id}:${task.stage}:${priorAttempts + 1}`;
      const idempotencyKey = `ariad:v2:${attemptId}`;

      try {
        this.store.updateTask(task.id, task.version, applyTaskEvent(task, 'START', {
          retryNotBefore: null,
          execution: {
            provider: spec.provider,
            externalId: null,
            attemptId,
            idempotencyKey,
            role: task.stage,
            completionProtocol: spec.completionProtocol ?? 'provider_terminal',
            protocolVersion: spec.completionProtocol === 'role_result_tool' ? 'role-result-v2' : 'provider-terminal-v1',
            projectVersion: project.activeVersion ?? project.projectVersion ?? 0,
            executionCapabilities: structuredClone(spec.executionCapabilities ?? []),
            provenance: structuredClone(spec.executionProvenance ?? {}),
            startedAt: new Date().toISOString(),
            resources: structuredClone(requirements),
            sessionPolicy: role.sessionPolicy ?? 'fresh',
          },
        }));
      } catch (error) {
        this.resources.release(task.id);
        if (String(error?.message).includes('version conflict')) continue;
        throw error;
      }

      // A task's first local dispatch takes the hold for its pipeline.
      if (!adhocOnly && !localHolder && requirements.includes(LOCAL_LLM_RESOURCE)) {
        localHolder = task;
        try {
          const fresh = this.store.getProject(projectId);
          if (fresh && fresh.localLlmHolderTaskId !== task.id) {
            this.store.updateProject?.(projectId, fresh.version, { localLlmHolderTaskId: task.id });
          }
        } catch { /* a lost hold write degrades to per-attempt dispatch */ }
      }

      try {
        const provider = this.providers.get(spec.provider);
        const handle = await provider.start({
          ...spec,
          projectId,
          taskId: task.id,
          role: task.stage,
          taskKind: task.taskKind,
          scope: scopeOfTask(task),
          flowId: task.flowId ?? null,
          sessionPolicy: role.sessionPolicy ?? 'fresh',
          attemptId,
          idempotencyKey,
        });
        const current = this.store.getTask(task.id);
        this.store.updateTask(task.id, current.version, {
          execution: {
            ...current.execution,
            externalId: handle?.externalId ?? handle?.id ?? null,
          },
        });
        started.push(task.id);
      } catch (error) {
        const current = this.store.getTask(task.id);
        const failure = error?.message ?? String(error);
        // Transient provider unavailability is an environment condition:
        // it does not consume an attempt, and the task waits out a
        // cooldown instead of burning its retries inside the provider's
        // recovery window. Only an outage that outlives the maximum
        // transient window escalates to SYSTEM_BLOCKED.
        const transient = isTransientProviderFailure(failure);
        const blocked = transient
          ? transientWindowExpired(current)
          : isNonretryableProviderFailure(failure) || systemFailureCount(current) >= 2;
        this.store.appendTaskHistory(task.id, current.version, {
          type: 'SYSTEM_INTERRUPTION',
          role: task.stage,
          failure,
          consumeAttempt: !transient,
          ...(transient ? { transient: true } : {}),
          at: new Date().toISOString(),
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
        if (blocked && localHolder?.id === task.id) localHolder = null;
        this.resources.release(task.id);
      }
    }

    // The task snapshot rides along so the caller (project state
    // derivation in the same reconcile pass) does not list every task
    // a second time in the same pass.
    return { started, tasks: allTasks };
  }
}

export { topologicalOrder, partitionGraphs };
