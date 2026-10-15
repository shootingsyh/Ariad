import { advanceNodePlanningWorkflows } from './node-planning-workflow-executor.js';
import { LegacyRoleResultExecutor } from './legacy-role-result-executor.js';
import { graphKey } from './sqlite-store.js';
import { buildExecutionGraph, partitionExecutionGraphs } from './execution-graph.js';
import { createNextPlanningBatch, isPlannerTask } from './planner-flow.js';
import { applyTaskEvent } from './state-machine.js';
import { developerTaskPolicyFailure } from './developer-task-policy.js';
import { controlTaskPolicyFailure, effectiveTaskKind, isAdhocAnalysis, TASK_KINDS } from './control-task-policy.js';

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
    this.resultExecutor = new LegacyRoleResultExecutor({ store, roles, uxReviewEnabled });
  }

  #settlePlanningBatches(projectId) {
    for (const batchId of this.store.listClaimedPlanningBatches(projectId)) {
      const flowId = `planner:${projectId}:${batchId}`;
      const tasks = this.store.listTasks(projectId, { flowId });
      if (tasks.length > 0 && tasks.every(task => ['DONE', 'SKIPPED'].includes(task.state))) {
        this.store.completePlanningBatch(projectId, batchId);
      }
    }
  }

  async tick(projectId, { adhocOnly = false } = {}) {
    const initialProject = this.store.getProject(projectId);
    if (!initialProject) throw new Error(`unknown project: ${projectId}`);
    const migrating = initialProject.planningModelMigration?.status === 'REBUILDING';
    await this.resultExecutor.advanceResults(projectId, { migrating, adhocOnly });
    if (!adhocOnly && !migrating) advanceNodePlanningWorkflows(this.store, projectId);
    if (!adhocOnly) {
      this.store.reconcileAssignedIssues?.(projectId);
      this.#settlePlanningBatches(projectId);
    }

    if (!adhocOnly && this.store.hasUnplannedPlanningRequests(projectId)) {
      const pending = this.store.listPlanningRequests(projectId, { states: ['PENDING'] });
      if (!migrating || pending.every(item =>
        ['VERSION_MIGRATION', 'VERSION_MIGRATION_FINALIZE'].includes(item.request?.purpose)
      )) {
        createNextPlanningBatch({ store: this.store, projectId });
      }
    }

    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);

    // Upgrade pre-split READY tester work to Test Engineer. Never interrupt
    // an in-flight tester; stopped/cancelled work is READY and safe to migrate.
    for (const task of this.store.listTasks(projectId)) {
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
    const allTasks = this.store.listTasks(projectId);
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
      task.stage === 'project_debugger' && task.scope === 'control' && Boolean(task.input?.blockedTaskId);
    // Migration is a project-level exclusive mode. Neither Delivery nor
    // ordinary planning/iteration/diagnostic roles may execute, regardless
    // of deliveryEnabled, PM authorization, or task graph state.
    const schedulableTasks = adhocOnly
      ? (migrating ? [] : allTasks.filter(isAdhocAnalysis))
      : migrating
      ? allTasks.filter(task => isPlannerTask(task) && task.input?.versionMigration === true)
      : planningBlocked
        ? allTasks.filter(task => isPlannerTask(task) || isUnifiedDiagnostic(task) || isAdhocAnalysis(task) || [TASK_KINDS.NODE_PLANNING, TASK_KINDS.GLOBAL_REVIEW].includes(effectiveTaskKind(task)))
        : allTasks.filter(task =>
            (!isPlannerTask(task) || isUnifiedDiagnostic(task))
            && (task.scope !== 'delivery' || deliveryEnabled)
          );
    const candidates = [];
    // Workflow parents are orchestrators, never Pi role sessions.
    // They must not be dispatched until a durable workflow executor owns them.

    for (const { key, graph } of partitionExecutionGraphs(schedulableTasks)) {
      for (const task of graph.tasks) {
        if (!graph.isRunnable(task) || effectiveTaskKind(task) === TASK_KINDS.WORKFLOW) continue;
        candidates.push({
          task,
          graphKey: key,
          impact: graph.downstreamImpact(task.id),
        });
      }
    }

    // Prefer work that can unblock the largest unfinished downstream region.
    // Stable deterministic tie-breakers keep scheduling reproducible.
    candidates.sort((a, b) =>
      b.impact - a.impact
      || a.graphKey.localeCompare(b.graphKey)
      || a.task.id.localeCompare(b.task.id)
    );

    const started = [];

    for (const candidate of candidates) {
      const task = this.store.getTask(candidate.task.id);
      if (task.state !== 'READY') continue;

      // Rebuild the task's graph from fresh durable state before claiming it.
      const sameGraphTasks = this.store.listTasks(projectId)
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
      if (!this.resources.claim(requirements, task.id)) continue;

      const priorAttempts = (task.history ?? []).filter(entry =>
        entry?.type === 'ROLE_RESULT'
        || (entry?.type === 'SYSTEM_INTERRUPTION' && entry?.consumeAttempt !== false)
      ).length;
      const attemptId = `${projectId}:${task.id}:${task.stage}:${priorAttempts + 1}`;
      const idempotencyKey = `ariad:v2:${attemptId}`;

      try {
        this.store.updateTask(task.id, task.version, applyTaskEvent(task, 'START', {
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

      try {
        const provider = this.providers.get(spec.provider);
        const handle = await provider.start({
          ...spec,
          projectId,
          taskId: task.id,
          role: task.stage,
          taskKind: effectiveTaskKind(task),
          scope: task.scope,
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
        const blocked = systemFailureCount(current) >= 2;
        this.store.appendTaskHistory(task.id, current.version, {
          type: 'SYSTEM_INTERRUPTION',
          role: task.stage,
          failure: error?.message ?? String(error),
          consumeAttempt: true,
          at: new Date().toISOString(),
        }, applyTaskEvent(
          current,
          blocked ? 'BLOCK_SYSTEM_FAILURE' : 'RETRY_SYSTEM_FAILURE',
          { execution: null },
        ));
        this.resources.release(task.id);
      }
    }

    return { started };
  }
}

export { topologicalOrder, partitionGraphs };
