import { join } from 'node:path';

import { SQLiteV2Store } from '../v2/sqlite-store.js';
import { RoleRegistry } from '../v2/role-registry.js';
import { ProviderRegistry } from '../v2/provider-registry.js';
import { ResourcePool, ScopedResourcePool } from '../v2/resource-pool.js';
import { V2Scheduler } from '../v2/scheduler.js';
import { V2Supervisor } from '../v2/supervisor.js';
import { FunctionProvider } from '../v2/function-provider.js';
import { createDefaultV2Roles } from '../v2/default-roles.js';
import { ensureTakeoverReviewState } from '../v2/takeover-gate.js';
import { applyTaskEvent } from '../v2/state-machine.js';
import { CURRENT_STORAGE_VERSION } from '../v2/schema-version.js';

/**
 * Standalone Ariad execution composition for one project.
 *
 * This class deliberately owns only Ariad orchestration. The provider owns the
 * primitive role run, while SQLite, scheduling, transitions and result
 * persistence remain in Ariad.
 */
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
    this.store = new SQLiteV2Store(project.stateDb);
    this.resources = new ScopedResourcePool(sharedResources, project.id);
    this.artifactRoot = join(project.workspace, '.ariad', 'artifacts');
    this.requestSequence = 0;

    if (!this.store.getProject(project.id)) {
      this.store.createProject({
        id: project.id,
        spec: project.goal ?? null,
        mode: project.mode ?? 'NEW',
        sourcePath: project.sourcePath ?? null,
        workspace: project.workspace,
        pmBinding: `pm:${project.id}`,
        deliveryEnabled: false,
        takeoverReviewRequired: (project.mode ?? 'NEW') === 'TAKEOVER',
        projectVersion: project.projectVersion ?? 0,
        activeVersion: project.activeVersion ?? 1,
        versionHistory: [],
        storageVersion: CURRENT_STORAGE_VERSION,
      });
    }
    ensureTakeoverReviewState(this.store, project.id);

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
      artifactRoot: this.artifactRoot,
      executionCapabilities,
      executionProvenance,
      codeIntelligence,
      resolveRoleExecutionMetadata: role => ({
        modelRef: this.resolveRoleModel(['feature_planner', 'milestone_planner', 'interface_architect'].includes(role) ? 'tech_lead' : role === 'ux_reviewer' ? 'reviewer' : role === 'test_engineer' ? 'tester' : role) ?? null,
      }),
      enqueuePlanning: ({ request }) => {
        this.store.enqueuePlanningRequest({
          id: `${project.id}:replan:${Date.now()}:${++this.requestSequence}`,
          projectId: project.id,
          request,
        });
      },
      requestPlanning: ({ phase, reason, scopeNodeId = null, nodes = null, requestedByTaskId = null }) =>
        this.store.createNodePlanningWorkflow({
          id: `${project.id}:node-plan:${Date.now()}:${++this.requestSequence}`,
          projectId: project.id, phase, reason, scopeNodeId, nodes, requestedByTaskId,
        }),
      reportIssue: issue => this.openIssue(issue),
      recoverLegacyIssueBlockedTask: args => this.store.recoverLegacyIssueBlockedTask({ ...args, projectId: this.projectId, actor: 'tech_lead' }),
      insertTriagedFixTask: args => this.store.insertTriagedFixTask({ ...args, projectId: this.projectId, actor: 'tech_lead' }),
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

  async tick({ schedule = true, adhocOnly = false } = {}) {
    const audit = await this.supervisor.audit(this.projectId, { adhocOnly });
    const scheduled = schedule ? await this.scheduler.tick(this.projectId, { adhocOnly }) : { started: [] };
    this.store.checkpoint();
    return { audit, scheduled, status: this.status() };
  }

  resumeSystemBlocked(reason = 'MANUAL_RESUME') {
    const recovered = [];
    for (const task of this.store.listTasks(this.projectId)) {
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
    for (const task of this.store.listTasks(this.projectId)) {
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
    const task = this.store.listTasks(this.projectId).find(item => item.state === 'NEEDS_HUMAN');
    if (!task) throw new Error('project has no pending human decision');
    const systemDiagnosis = task.stage === 'project_debugger' && Boolean(task.input?.blockedTaskId);
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

  status() {
    const tasks = this.store.listTasks(this.projectId);
    const project = this.store.getProject(this.projectId);
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
    };
  }

  close() {
    this.codeIntelligence?.close?.();
    this.store.close();
  }
}
