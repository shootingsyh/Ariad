import { join } from 'node:path';

import { SQLiteV2Store, isStaleStoreViewError } from '../v2/sqlite-store.js';
import { VersionedTaskStore } from '../v2/versioned-task-store.js';
import { RoleRegistry } from '../v2/role-registry.js';
import { ProviderRegistry } from '../v2/provider-registry.js';
import { ResourcePool, ScopedResourcePool } from '../v2/resource-pool.js';
import { V2Scheduler } from '../v2/scheduler.js';
import { V2Supervisor } from '../v2/supervisor.js';
import { FunctionProvider } from '../v2/function-provider.js';
import { createDefaultV2Roles } from '../v2/default-roles.js';
import { ensureTakeoverReviewState } from '../v2/takeover-gate.js';
import { applyTaskEvent } from '../v2/state-machine.js';
import { TASK_KINDS, openDiagnosisGate, scopeOfTask } from '../v2/control-task-policy.js';
import { diagnosisTaskView } from '../v2/system-block-diagnosis.js';
import { auditTasks } from '../v2/dispatch-fairness.js';
import { CURRENT_STORAGE_VERSION } from '../v2/schema-version.js';

/**
 * Standalone Ariad execution composition for one project.
 *
 * This class deliberately owns only Ariad orchestration. The provider owns the
 * primitive role run, while SQLite, scheduling, transitions and result
 * persistence remain in Ariad.
 */
// Local replan (owner decision, 2026-11-02): the operator entrance that
// actualizes an owner decision (for example the conclusion of a read-only
// analyze) as a bounded change to the current plan. Unlike begin-iteration
// it never stops or archives the project; unlike analyze it is not
// read-only - it enqueues a planning request that the Tech Lead consumes
// in the next planning batch under the boundary in LOCAL_REPLAN_GUIDANCE.
export const LOCAL_REPLAN_GUIDANCE = [
  'Actualize this project-owner decision as a LOCAL replan: the smallest correct change to the current plan.',
  'You may amend not-yet-started features and tasks, add bounded new tasks, and remove not-yet-started tasks (a task removed from the spec is obsoleted at promotion).',
  'Never modify, remove, or re-run DONE work or work in flight (WORKING / RESULT_READY); executed-work protection at promotion is a backstop, not permission to try.',
  'Do not stop the project, archive its store, or start a new iteration.',
  'If the decision mandates a change to REQUIREMENTS.md wording, the PM revises the document and obtains owner approval of the new hash before decomposition (the batch opens with that PM task); do not edit the document yourself, and do not plan against unapproved text.',
].join(' ');

export class StandaloneProjectRuntime {
  constructor({
    project,
    provider,
    resolveRoleModel,
    sharedResources = new ResourcePool({ 'local-llm': 1 }),
    sourceControl = null,
    executionCapabilities = [],
    executionProvenance = {},
    incidentSink = null,
    codeIntelligence = null,
    onStoreFatal = null,
    storeFatalThreshold = 3,
  }) {
    if (!project?.id || !project?.workspace || !project?.stateDb) {
      throw new Error('StandaloneProjectRuntime requires project id, workspace, and stateDb');
    }
    if (!provider) throw new Error('StandaloneProjectRuntime requires a provider');
    if (typeof resolveRoleModel !== 'function') {
      throw new Error('StandaloneProjectRuntime requires resolveRoleModel(role)');
    }

    this.project = project;
    this.projectId = project.id;
    this.provider = provider;
    this.resolveRoleModel = resolveRoleModel;
    this.codeIntelligence = codeIntelligence;
    this.onStoreFatal = onStoreFatal;
    this.storeFatalThreshold = storeFatalThreshold;
    this.consecutiveStoreFailures = 0;
    this.store = new SQLiteV2Store(project.stateDb);
    this.resources = new ScopedResourcePool(sharedResources, project.id);
    this.artifactRoot = join(project.workspace, '.ariad', 'artifacts');
    this.requestSequence = 0;

    if (!this.store.getProject(project.id)) {
      this.store.createProject({
        id: project.id,
        goal: project.goal ?? null,
        spec: project.goal ?? null,
        mode: project.mode ?? 'NEW',
        sourcePath: project.sourcePath ?? null,
        workspace: project.workspace,
        pmBinding: `pm:${project.id}`,
        deliveryEnabled: false,
        versionedTree: project.versionedTree === true,
        takeoverReviewRequired: (project.mode ?? 'NEW') === 'TAKEOVER',
        projectVersion: project.projectVersion ?? 0,
        activeVersion: project.activeVersion ?? 1,
        versionHistory: [],
        storageVersion: CURRENT_STORAGE_VERSION,
      });
    }
    ensureTakeoverReviewState(this.store, project.id);
    // DB-first projects execute the prod task tree in place: swap the
    // runtime store for the de-materialized facade before any role,
    // scheduler or supervisor sees it.
    if (this.store.getProject(project.id)?.versionedTree === true) {
      this.store = new VersionedTaskStore(this.store);
    }

    const providers = new ProviderRegistry();
    providers.register(provider);
    providers.register(new FunctionProvider());
    this.providers = providers;

    const roleRegistry = new RoleRegistry();
    const roleDefinitions = createDefaultV2Roles({
      store: this.store,
      providerId: provider.id,
      completionProtocol: 'provider_terminal',
      codeProviderId: 'ariad-code',
      workspace: project.workspace,
      sourceControl,
      uxReviewEnabled: project.uxReview?.enabled === true,
      debugHoldAfterPlanReview: project.debug?.holdAfterPlanReview === true,
      artifactRoot: this.artifactRoot,
      executionCapabilities,
      executionProvenance,
      codeIntelligence,
      resolveRoleExecutionMetadata: role => ({
        modelRef: this.resolveRoleModel(role === 'ux_reviewer' ? 'reviewer' : role === 'test_engineer' ? 'tester' : role) ?? null,
      }),
      enqueuePlanning: ({ request }) => {
        this.store.enqueuePlanningRequest({
          id: `${project.id}:replan:${Date.now()}:${++this.requestSequence}`,
          projectId: project.id,
          request,
        });
      },
      reportIssue: issue => this.openIssue(issue),
      insertTriagedFixTask: args => this.store.insertTriagedFixTask({ ...args, projectId: this.projectId, actor: 'tech_lead' }),
      projectStoreFile: this.store.filePath ?? null,
    });
    for (const [name, definition] of Object.entries(roleDefinitions)) {
      roleRegistry.register(name, definition);
    }
    this.roles = roleRegistry;

    this.scheduler = new V2Scheduler({
      store: this.store,
      roles: roleRegistry,
      providers,
      resources: this.resources,
    });
    this.supervisor = new V2Supervisor({
      store: this.store,
      providers,
      resources: this.resources,
      incidentSink,
      startDiagnosisSession: async ({ projectId, task, attemptId }) => {
        // The supervisor runs the debugger session itself; this starter
        // is the runtime's half of that arrangement (the role registry
        // and the providers live here). The session runs on the blocked
        // task itself: no diagnostic task is created or scheduled.
        const project = this.store.getProject(projectId);
        const role = roleRegistry.get('project_debugger');
        const view = diagnosisTaskView(task);
        const spec = role.prepare({ project, task: view });
        if (!spec?.provider) throw new Error('project_debugger role produced no provider');
        const requirements = spec.resources ?? [];
        if (requirements.length && !this.resources.claim(requirements, task.id)) {
          throw new Error('diagnosis session resources unavailable');
        }
        try {
          const provider = providers.get(spec.provider);
          const handle = await provider.start({
            ...spec,
            projectId,
            taskId: task.id,
            role: 'project_debugger',
            taskKind: TASK_KINDS.DIAGNOSTIC,
            scope: scopeOfTask(view),
            flowId: `diagnostic:${projectId}`,
            sessionPolicy: spec.sessionPolicy ?? role.sessionPolicy ?? 'fresh',
            attemptId,
            idempotencyKey: `ariad:v2:${attemptId}`,
          });
          return {
            provider: spec.provider,
            externalId: handle?.externalId ?? handle?.id ?? null,
            completionProtocol: spec.completionProtocol ?? 'provider_terminal',
          };
        } catch (error) {
          this.resources.release(task.id);
          throw error;
        }
      },
    });
    this.supervisor.recover(project.id);
  }

  openIssue(issue = {}) {
    const created = this.store.createIssue({
      projectId: this.projectId,
      ...structuredClone(issue),
    });
    if (!created.planningRequestId && !['CLOSED', 'REJECTED'].includes(created.state)) {
      const requestId = `${this.projectId}:issue:${created.fingerprint}:${++this.requestSequence}`;
      this.store.enqueuePlanningRequest({
        id: requestId,
        projectId: this.projectId,
        request: {
          purpose: 'TRIAGE_AND_ASSIGN_ISSUE',
          issueId: created.id,
          issue: created,
          instruction: 'Triage this issue against the current feature/interface ownership. Reject duplicates/non-defects; otherwise assign the repair to the correct existing owner or revise the boundary if no valid owner exists. Create/update a bounded delivery repair task and preserve issueRefs=[issueId] on that task.',
        },
        context: { sourceKind: created.source?.kind ?? 'internal', issueId: created.id },
      });
      return this.store.updateIssue(created.id, { state: 'TRIAGE_PENDING', planningRequestId: requestId });
    }
    return created;
  }

  enqueueLocalReplan({ id, instruction } = {}) {
    if (!String(instruction ?? '').trim()) throw new Error('LOCAL_REPLAN_REQUIRES_INSTRUCTION');
    const requestId = `${this.projectId}:local-replan:${id ?? Date.now()}:${++this.requestSequence}`;
    return this.store.enqueuePlanningRequest({
      id: requestId,
      projectId: this.projectId,
      request: {
        purpose: 'LOCAL_REPLAN',
        requestedBy: 'project-owner',
        instruction,
        guidance: LOCAL_REPLAN_GUIDANCE,
      },
      context: { sourceKind: 'project-owner-decision' },
    });
  }

  async tick({ schedule = true, adhocOnly = false } = {}) {
    try {
      const result = await this.#tickOnce({ schedule, adhocOnly });
      this.consecutiveStoreFailures = 0;
      return result;
    } catch (error) {
      if (!isStaleStoreViewError(error)) throw error;
      // A store handle can go stale underneath a healthy WAL file (other
      // connections cycling the WAL): every operation then fails with a
      // stale-view error (SQLITE_IOERR, or SQLITE_MALFORMED since
      // 2026-11-22) while a fresh connection works (2026-11-01 signal
      // incident; 2026-11-02 supervisor.audit -> listTasks; 2026-11-22
      // versioned listExecTasks). Reopen the project stores once and
      // retry the tick before the failure is allowed to park the project.
      this.store.reopen?.();
      try {
        const result = await this.#tickOnce({ schedule, adhocOnly });
        this.consecutiveStoreFailures = 0;
        return result;
      } catch (retryError) {
        if (isStaleStoreViewError(retryError)) {
          // The reopen did not heal it - this is not a stale view.
          // Count consecutive unhealed ticks; at the threshold the host
          // is told the store is fatal (the daemon exits and a fresh
          // process takes over) instead of retrying forever.
          this.consecutiveStoreFailures += 1;
          if (this.consecutiveStoreFailures >= this.storeFatalThreshold) {
            this.onStoreFatal?.(this.projectId, retryError);
          }
        }
        throw retryError;
      }
    }
  }

  async #tickOnce({ schedule = true, adhocOnly = false } = {}) {
    const audit = await this.supervisor.audit(this.projectId, { adhocOnly });
    const scheduled = schedule ? await this.scheduler.tick(this.projectId, { adhocOnly }) : { started: [] };
    this.store.checkpoint();
    return { audit, scheduled, status: this.status(scheduled?.tasks) };
  }

  resumeSystemBlocked(reason = 'MANUAL_RESUME') {
    const recovered = [];
    for (const task of this.store.listTasks(this.projectId, { states: ['SYSTEM_BLOCKED'] })) {
      if (task.state !== 'SYSTEM_BLOCKED') continue;
      const lastFailure = [...(task.history ?? [])]
        .reverse()
        .find(entry => entry?.type === 'SYSTEM_INTERRUPTION');
      // A planning task parked in SYSTEM_BLOCKED at the debugger stage
      // has already received the debugger's terminal diagnosis. A manual
      // resume means the operator changed the conditions (for example
      // fixed the runtime the diagnosis blamed); re-running the debugger
      // on the same evidence only repeats its verdict and re-blocks the
      // task without the repairing role ever re-running (iterprobe
      // repair-1, 2026-10-31: two manual resumes, two identical
      // diagnoses, artifacts untouched). Route those back to the tech
      // lead with a fresh gate-retry budget; the diagnosis stays in
      // history as evidence, and if the repair fails again the ladder
      // re-engages on its own.
      const planningDebuggerBlock = task.taskKind === 'PLANNING'
        && task.stage === 'project_debugger'
        && (task.history ?? []).some(entry => entry?.type === 'PLAN_DEBUGGER_DIAGNOSIS');
      const recoveryPatch = { execution: null };
      if (planningDebuggerBlock) {
        recoveryPatch.stage = 'tech_lead';
        recoveryPatch.input = { ...(task.input ?? {}), planGateRetries: 0 };
      }
      this.store.appendTaskHistory(task.id, task.version, {
        type: 'SYSTEM_RECOVERY',
        role: task.stage,
        reason,
        previousFailure: lastFailure?.failure ?? null,
        recoveredToStage: planningDebuggerBlock ? 'tech_lead' : task.stage,
        at: new Date().toISOString(),
      }, applyTaskEvent(task, 'RECOVER', recoveryPatch));
      this.resources.release(task.id);
      recovered.push(task.id);
    }
    return recovered;
  }

  async cancelActive(reason = 'PROJECT_STOPPED') {
    const cancelled = [];
    for (const task of this.store.listTasks(this.projectId, { states: ['WORKING'] })) {
      if (task.state !== 'WORKING') continue;
      const execution = task.execution;
      if (execution?.provider && execution?.externalId) {
        const provider = this.providers.get(execution.provider);
        await provider.cancel({
          externalId: execution.externalId,
          taskId: task.id,
        });
      }
      const current = this.store.getTask(task.id);
      this.store.appendTaskHistory(current.id, current.version, {
        type: 'SYSTEM_INTERRUPTION',
        role: current.stage,
        failure: reason,
        consumeAttempt: false,
        cancelled: true,
        at: new Date().toISOString(),
      }, applyTaskEvent(current, 'CANCEL', {
        execution: null,
      }));
      this.resources.release(current.id);
      cancelled.push(current.id);
    }
    return cancelled;
  }

  submitDecision(decision) {
    const tasks = this.store.listTasks(this.projectId, { states: ['NEEDS_HUMAN', 'SYSTEM_BLOCKED'] });
    const gateTask = tasks.find(item => item.state === 'NEEDS_HUMAN');
    const task = gateTask ?? tasks.find(item =>
      item.state === 'SYSTEM_BLOCKED' && openDiagnosisGate(item));
    if (!task) throw new Error('project has no pending human decision');
    const systemDiagnosis = Boolean(openDiagnosisGate(task))
      || (task.stage === 'project_debugger' && Boolean(task.input?.blockedTaskId));
    if (!gateTask && systemDiagnosis) {
      // The gate lives on the blocked task itself (supervisor-managed
      // diagnosis): record the decision in its history and leave the
      // task SYSTEM_BLOCKED - the operator resume that follows performs
      // the recovery (SYSTEM_RECOVERY), as it did when the gate was a
      // separate diagnostic task.
      const updated = this.store.appendTaskHistory(task.id, task.version, {
        type: 'HUMAN_DECISION',
        decision,
        at: new Date().toISOString(),
      }, { ...task, execution: null });
      return {
        taskId: updated.id,
        decision,
        systemDiagnosis,
        blockedTaskId: task.id,
        taskState: updated.state,
      };
    }
    const updated = this.store.appendTaskHistory(task.id, task.version, {
      type: 'HUMAN_DECISION',
      decision,
      at: new Date().toISOString(),
    }, applyTaskEvent(task, 'HUMAN_DECISION', {
      execution: null,
    }, { systemDiagnosis }));
    return {
      taskId: updated.id,
      decision,
      systemDiagnosis,
      blockedTaskId: systemDiagnosis ? task.input?.blockedTaskId ?? null : null,
      taskState: updated.state,
    };
  }

  status(tasks = null) {
    // The tick passes the scheduler's task snapshot from this same pass;
    // listing again here re-parsed the whole ledger a second time per
    // pass. Standalone callers (CLI status) omit it and list fresh.
    tasks ??= this.store.listTasks(this.projectId, { all: true });
    const project = this.store.getProject(this.projectId);
    // Dispatch fairness (SRPG 2026-11-14): READY conflates three states —
    // runnable and queued, blocked on unfinished dependencies, and
    // runnable-but-starved. Name the latter two so the watch and the
    // operator stop reading a synthetic READY as real progress.
    const fairnessAudit = auditTasks(
      tasks.filter(task => scopeOfTask(task) === 'delivery'),
      {
        nowMs: Date.now(),
        firstSeenAt: new Map(
          tasks
            .filter(task => scopeOfTask(task) === 'delivery')
            .map(task => [task.id, this.store.specFirstSeenAt?.(task.id) ?? task.createdAt ?? null])
            .filter(([, at]) => at != null),
        ),
      },
    );
    return {
      projectId: this.projectId,
      deliveryEnabled: project?.deliveryEnabled === true,
      storageVersion: project?.storageVersion ?? 1,
      tasks: {
        total: tasks.length,
        ready: tasks.filter(task => task.state === 'READY').length,
        working: tasks.filter(task => task.state === 'WORKING').length,
        resultReady: tasks.filter(task => task.state === 'RESULT_READY').length,
        done: tasks.filter(task => task.state === 'DONE').length,
        blocked: tasks.filter(task => task.state === 'SYSTEM_BLOCKED').length,
        needsHuman: tasks.filter(task => task.state === 'NEEDS_HUMAN').length,
      },
      activeTasks: tasks
        .filter(task => !['DONE', 'SKIPPED', 'OBSOLETE'].includes(task.state))
        .map(task => ({ id: task.id, stage: task.stage, state: task.state })),
      starvedTasks: fairnessAudit
        .filter(entry => entry.starved)
        .map(entry => ({ id: entry.id, runnableSinceMs: entry.runnableSinceMs, waitMs: entry.waitMs })),
      blockedTasks: fairnessAudit
        .filter(entry => !entry.runnable && entry.blockedBy.length > 0)
        .map(entry => ({ id: entry.id, blockedBy: entry.blockedBy })),
    };
  }

  close() {
    this.codeIntelligence?.close?.();
    this.store.close();
  }
}
