import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitSourceControlFinalizer } from '../../../src/git-source-control-finalizer.js';
import { SQLiteV2Store } from '../../../src/v2/sqlite-store.js';
import { RoleRegistry } from '../../../src/v2/role-registry.js';
import { ProviderRegistry } from '../../../src/v2/provider-registry.js';
import { ResourcePool, ScopedResourcePool } from '../../../src/v2/resource-pool.js';
import { V2Scheduler } from '../../../src/v2/scheduler.js';
import { V2Supervisor } from '../../../src/v2/supervisor.js';
import { FunctionProvider } from '../../../src/v2/function-provider.js';
import { createDefaultV2Roles } from '../../../src/v2/default-roles.js';
import { aggregateTesterSubmission } from '../../../src/v2/acceptance.js';
import { bootstrapProject } from '../../../src/v2/project-bootstrap.js';
import type { OpenClawV2Provider } from './openclaw-v2-provider.js';
import { requireCompleteRoleModels } from '../runtime/role-models.js';
import { ReconcileTrigger } from '../../../src/v2/reconcile-trigger.js';
import { SQLiteReconcileSignal } from '../../../src/v2/sqlite-reconcile-signal.js';
import { FileReconcileWake } from '../../../src/v2/file-reconcile-wake.js';
import { restartOrphanEvidence } from '../../../src/v2/restart-orphan-recovery.js';
import { legacyHumanGateTarget } from '../../../src/v2/legacy-human-gate-recovery.js';
import { buildDurableRuntimeStatus } from '../../../src/v2/durable-runtime-status.js';
import { ensureTakeoverReviewState, recoverObsoleteTakeoverHumanGates } from '../../../src/v2/takeover-gate.js';

type ProjectManager = {
  list(): any[];
  status(name: string): any;
  setDesiredState(name: string, state: string): any;
  setExecutionState(name: string, state: string): any;
  setVersionState?(name: string, value: { projectVersion?: number; activeVersion?: number }): any;
};

function workspaceIsEmpty(path: string) {
  return readdirSync(path, { withFileTypes: true }).every(entry => ['.git', '.ariad'].includes(entry.name));
}

class ProjectRuntime {
  private readonly manager: ProjectManager;
  private readonly projectId: string;
  private readonly store: SQLiteV2Store;
  private readonly scheduler: V2Scheduler;
  private readonly supervisor: V2Supervisor;
  private readonly resources: ScopedResourcePool;
  private readonly sourceControl: GitSourceControlFinalizer;
  private readonly logger: any;
  private readonly executionCapabilities: string[];
  private readonly executionProvenance: Record<string, unknown>;
  private readonly workspace: string;
  private readonly artifactRoot: string;
  private readonly wakeScheduler: (reason: string) => void;
  private ticking = false;
  private requestSequence = 0;

  constructor({
    manager,
    project,
    provider,
    pushSourceControl,
    logger,
    executionCapabilities = [],
    executionProvenance = {},
    wakeScheduler = () => {},
    sharedResources,
  }: {
    manager: ProjectManager;
    project: any;
    provider: OpenClawV2Provider;
    pushSourceControl: boolean;
    logger?: any;
    executionCapabilities?: string[];
    executionProvenance?: Record<string, unknown>;
    wakeScheduler?: (reason: string) => void;
    sharedResources: ResourcePool;
  }) {
    this.manager = manager;
    this.logger = logger;
    this.executionCapabilities = [...executionCapabilities];
    this.executionProvenance = structuredClone(executionProvenance);
    this.wakeScheduler = wakeScheduler;
    this.projectId = project.id;
    this.workspace = project.workspace;
    this.artifactRoot = join(project.workspace, '.ariad', 'artifacts');
    this.store = new SQLiteV2Store(project.stateDb);

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
      });
    } else {
      const durable = this.store.getProject(project.id);
      if (!Number.isInteger(durable.projectVersion) || !Number.isInteger(durable.activeVersion)) {
        const legacyCompleted = project.executionState === 'SUCCEEDED';
        const completedVersion = Number.isInteger(project.projectVersion)
          ? project.projectVersion
          : (legacyCompleted ? 1 : 0);
        const activeVersion = Number.isInteger(project.activeVersion)
          ? project.activeVersion
          : Math.max(1, completedVersion || 1);
        this.store.updateProject(project.id, durable.version, {
          projectVersion: completedVersion,
          activeVersion,
          versionHistory: durable.versionHistory ?? (
            completedVersion > 0
              ? [{ version: completedVersion, completedAt: project.updatedAt ?? project.createdAt ?? null, migrated: true }]
              : []
          ),
        });
      }
    }

    ensureTakeoverReviewState(this.store, project.id);

    const providers = new ProviderRegistry();
    providers.register(provider);
    providers.register(new FunctionProvider());

    this.resources = new ScopedResourcePool(sharedResources, project.id);
    this.sourceControl = new GitSourceControlFinalizer({
      workspace: project.workspace,
      push: pushSourceControl,
    });

    const roleRegistry = new RoleRegistry();
    const roleDefinitions = (createDefaultV2Roles as any)({
      store: this.store,
      providerId: provider.id,
      completionProtocol: 'role_result_tool',
      codeProviderId: 'ariad-code',
      workspace: project.workspace,
      sourceControl: this.sourceControl,
      artifactRoot: this.artifactRoot,
      executionCapabilities: this.executionCapabilities,
      executionProvenance: this.executionProvenance,
      resolveRoleExecutionMetadata: (role: string) => {
        const roleModels = this.manager.status(project.id).roleModels as Record<string, string | undefined>;
        return { modelRef: roleModels?.[role] ?? null };
      },
      enqueuePlanning: ({ request }: any) => {
        const id = `${project.id}:replan:${Date.now()}:${++this.requestSequence}`;
        this.store.enqueuePlanningRequest({
          id,
          projectId: project.id,
          request,
        });
        // A replan can be created by a transition inside the current reconcile.
        // Durable generation protects races; this explicit wake ensures the
        // sleeping process immediately runs the newly-created planning batch.
        this.wakeScheduler('planning-enqueued');
      },
    });
    for (const [name, definition] of Object.entries(roleDefinitions)) {
      roleRegistry.register(name, definition as any);
    }

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
    });
    this.supervisor.recover(project.id);

    const hasTasks = this.store.listTasks(project.id).length > 0;
    const hasPlanning = this.store.listPlanningRequests(project.id).length > 0;
    if (!hasTasks && !hasPlanning) {
      const mode = project.mode ?? 'NEW';
      const empty = workspaceIsEmpty(project.workspace);
      if (mode === 'TAKEOVER') {
        this.store.enqueuePlanningRequest({
          id: `bootstrap:${project.id}:takeover`,
          projectId: project.id,
          request: {
            purpose: 'RESTORE_PROJECT_STATE',
            goal: project.goal ?? null,
            sourcePath: project.sourcePath ?? null,
            instruction: 'Reconstruct this existing project into Ariad durable state, preserve/reuse valid work, and stop for human takeover review before any delivery work starts.',
          },
          context: { bootstrap: true, mode: 'TAKEOVER', sourcePath: project.sourcePath ?? null } as any,
        });
      } else if (empty) {
        if (project.goal) {
          this.store.enqueuePlanningRequest({
            id: `bootstrap:${project.id}:goal`,
            projectId: project.id,
            request: {
              purpose: 'INITIAL_PLAN',
              goal: project.goal,
            },
          });
        }
      } else {
        bootstrapProject({
          store: this.store,
          projectId: project.id,
          directoryEmpty: false,
          flowId: `bootstrap:${project.id}`,
        });
      }
    }
  }

  recoverObsoleteTakeoverGate() {
    return recoverObsoleteTakeoverHumanGates(this.store, this.projectId);
  }

  status() {
    const tasks = this.store.listTasks(this.projectId);
    const planning = this.store.listPlanningRequests(this.projectId);
    const project = this.store.getProject(this.projectId);
    return {
      deliveryEnabled: project?.deliveryEnabled === true,
      projectVersion: project?.projectVersion ?? 0,
      activeVersion: project?.activeVersion ?? 1,
      versionHistory: project?.versionHistory ?? [],
      executionCapabilities: [...this.executionCapabilities],
      executionProvenance: structuredClone(this.executionProvenance),
      tasks: {
        total: tasks.length,
        working: tasks.filter(task => task.state === 'WORKING').length,
        ready: tasks.filter(task => task.state === 'READY').length,
        needsHuman: tasks.filter(task => task.state === 'NEEDS_HUMAN').length,
        done: tasks.filter(task => task.state === 'DONE').length,
      },
      planning: {
        pending: planning.filter(item => item.state === 'PENDING').length,
        claimed: planning.filter(item => item.state === 'CLAIMED').length,
        planned: planning.filter(item => item.state === 'PLANNED').length,
      },
      activeTasks: tasks
        .filter(task => !['DONE', 'SKIPPED', 'OBSOLETE'].includes(task.state))
        .map(task => {
          const interruption = [...(task.history ?? [])].reverse().find(entry => entry?.type === 'SYSTEM_INTERRUPTION');
          return {
            id: task.id,
            stage: task.stage,
            state: task.state,
            ...(interruption?.failure ? { lastSystemFailure: interruption.failure } : {}),
          };
        }),
      humanDecisions: tasks
        .filter(task => task.state === 'NEEDS_HUMAN')
        .map(task => {
          const history = task.history ?? [];
          const roleResult = [...history].reverse().find(entry => entry?.type === 'ROLE_RESULT');
          const decisionContext = [...history].reverse().find(entry =>
            entry?.type !== 'ROLE_RESULT'
            && entry?.type !== 'SYSTEM_INTERRUPTION'
            && entry?.type !== 'SYSTEM_RECOVERY'
          );
          return {
            taskId: task.id,
            stage: task.stage,
            title: task.title ?? task.input?.title ?? null,
            summary: decisionContext?.summary ?? roleResult?.summary ?? null,
            questions: decisionContext?.questions ?? roleResult?.result?.questions ?? [],
            guidance: decisionContext?.guidance ?? roleResult?.result?.guidance ?? null,
            outcome: roleResult?.outcome ?? null,
            result: roleResult?.result ?? null,
          };
        }),
    };
  }

  snapshotCompletedVersion(version: number) {
    if (!Number.isInteger(version) || version < 1) throw new Error('completed project version is required for iteration snapshot');
    const snapshotRoot = join(this.workspace, '.ariad', 'versions', `v${version}`);
    const manifestPath = join(snapshotRoot, 'snapshot.json');
    if (existsSync(manifestPath)) {
      return { version, snapshotRoot, manifestPath, reused: true };
    }

    mkdirSync(snapshotRoot, { recursive: true });
    const plannerRoot = join(this.artifactRoot, 'planner');
    const logicalDir = join(plannerRoot, 'logical');
    const milestoneDir = join(plannerRoot, 'milestones');
    if (existsSync(logicalDir)) cpSync(logicalDir, join(snapshotRoot, 'logical'), { recursive: true });
    if (existsSync(milestoneDir)) cpSync(milestoneDir, join(snapshotRoot, 'milestones'), { recursive: true });

    const project = this.store.getProject(this.projectId);
    const deliveryTasks = this.store.listTasks(this.projectId, { scope: 'delivery' });
    const snapshot = {
      snapshotVersion: 1,
      projectId: this.projectId,
      projectVersion: version,
      capturedAt: new Date().toISOString(),
      logicalRootId: project.logicalRootId ?? null,
      logicalNodes: structuredClone(project.logicalNodes ?? []),
      milestones: structuredClone(project.milestones ?? []),
      deliveryPlanVersion: project.deliveryPlanVersion ?? null,
      deliveryPlanSummary: project.deliveryPlanSummary ?? null,
      deliveryRootTaskId: project.deliveryRootTaskId ?? null,
      deliveryTasks: structuredClone(deliveryTasks),
    };
    writeFileSync(manifestPath, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
    return { version, snapshotRoot, manifestPath, reused: false };
  }

  beginIteration(request: string) {
    if (!request?.trim()) throw new Error('iteration request is required');
    let project = this.store.getProject(this.projectId);
    const completedVersion = Number.isInteger(project.projectVersion) ? project.projectVersion : 0;
    const activeVersion = completedVersion + 1;
    const snapshot = this.snapshotCompletedVersion(completedVersion);
    project = this.store.updateProject(this.projectId, project.version, {
      deliveryEnabled: false,
      activeVersion,
      iterationBaseSnapshot: snapshot.manifestPath,
    });
    const planningRequest = this.store.enqueuePlanningRequest({
      id: `${this.projectId}:iterate:v${activeVersion}:${Date.now()}:${++this.requestSequence}`,
      projectId: this.projectId,
      request: {
        purpose: 'UPDATE_DELIVERY_PLAN',
        iteration: activeVersion,
        instruction: request.trim(),
        lifecycleRule: [
          'The previous completed version has been snapshotted immutably before this iteration.',
          'Produce feature-tree-diff.json as the authoritative feature change set against the immutable previous-version snapshot. Use stable-id add/update/remove operations; Ariad will deterministically apply the diff and materialize the next living feature tree.',
          'Replan the milestone tree for the target version; do not copy the old milestone execution plan merely to preserve history because the previous version snapshot is authoritative history.',
          'Preserve all previously DONE task history. Do not reopen DONE task ids merely because a new version exists.',
          'For unchanged feature branches, perform impact analysis. If they are not affected by revised dependencies/descendants, do not modify product code: create regression verification tasks and reuse existing valid tests/E2E flows.',
          'For revised or added feature branches, create implementation work and update/add the affected tests and E2E scenarios. Reuse still-valid old tests instead of rewriting them gratuitously.',
          'Parent/integration nodes whose descendants changed require fresh integrated regression/E2E verification even when the parent feature definition itself is unchanged.',
          'Every important feature, milestone, and the project root still require fresh realistic end-to-end verification for this version.',
        ].join(' '),
      },
      context: {
        sourceKind: 'iteration',
        fromVersion: completedVersion,
        targetVersion: activeVersion,
        baseSnapshot: snapshot.manifestPath,
      } as any,
    });
    this.manager.setVersionState?.(this.projectId, { projectVersion: completedVersion, activeVersion });
    return { planningRequest, snapshot, project: this.status() };
  }

  ensureUnifiedDebuggerTasks() {
    const tasks = this.store.listTasks(this.projectId);

    // Migrate durable 0.7.9/0.8.0 diagnostic sidecars in place.
    for (const legacy of tasks.filter((task: any) => task.stage === 'system_debugger')) {
      this.store.updateTask(legacy.id, legacy.version, { stage: 'project_debugger' });
    }

    const migrated = this.store.listTasks(this.projectId);
    for (const diagnostic of migrated.filter((task: any) =>
      task.stage === 'project_debugger' && task.input?.blockedTaskId && task.state === 'SYSTEM_BLOCKED'
    )) {
      this.store.appendTaskHistory(diagnostic.id, diagnostic.version, {
        type: 'SYSTEM_DIAGNOSIS_FAILED',
        role: 'project_debugger',
        blockedTaskId: diagnostic.input?.blockedTaskId ?? null,
        summary: 'Unified Project Debugger itself could not run after automatic retries. Human inspection is required.',
        questions: ['Inspect the Ariad/OpenClaw/model/runtime failure manually. The diagnostic run itself could not complete.'],
        at: new Date().toISOString(),
      }, {
        state: 'NEEDS_HUMAN',
        execution: null,
      });
    }

    const refreshed = this.store.listTasks(this.projectId);
    for (const blocked of refreshed.filter((task: any) =>
      task.state === 'SYSTEM_BLOCKED' && !(task.stage === 'project_debugger' && task.input?.blockedTaskId)
    )) {
      const blockedHistoryLength = (blocked.history ?? []).length;
      const existing = refreshed.find((task: any) =>
        task.stage === 'project_debugger'
        && task.scope === 'control'
        && task.input?.blockedTaskId === blocked.id
        && task.input?.blockedHistoryLength === blockedHistoryLength
      );
      if (existing) continue;

      const recentHistory = structuredClone((blocked.history ?? []).slice(-20));
      const incidents = this.store.listIncidents(this.projectId)
        .filter((incident: any) => incident?.taskId === blocked.id)
        .slice(-10);
      const sequence = refreshed.filter((task: any) =>
        task.stage === 'project_debugger' && task.input?.blockedTaskId === blocked.id
      ).length + 1;
      const diagnosticId = `debug:${blocked.id}:${sequence}`;
      this.store.createTask({
        id: diagnosticId,
        projectId: this.projectId,
        scope: 'control',
        flowId: diagnosticId,
        parentId: null,
        dependsOn: [],
        stage: 'project_debugger',
        state: 'READY',
        title: `Diagnose blocked task: ${blocked.id}`,
        intent: 'Diagnose the root cause across task/project/model/runtime evidence and route the correct repair without directly performing it.',
        acceptanceCriteria: [],
        verification: [],
        history: [],
        artifacts: [],
        execution: null,
        input: {
          blockedTaskId: blocked.id,
          blockedHistoryLength,
          systemIncident: {
            blockedTask: {
              id: blocked.id,
              scope: blocked.scope ?? null,
              stage: blocked.stage,
              state: blocked.state,
              title: blocked.title ?? null,
              execution: structuredClone(blocked.execution ?? null),
              recentHistory,
            },
            incidents: structuredClone(incidents),
          },
        },
      });
      this.wakeScheduler('unified-debugger-enqueued');
    }
  }

  async tick({ schedule = true }: { schedule?: boolean } = {}) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.supervisor.audit(this.projectId);
      this.ensureUnifiedDebuggerTasks();
      if (schedule) await this.scheduler.tick(this.projectId);
      this.ensureUnifiedDebuggerTasks();

      const tasks = this.store.listTasks(this.projectId);
      const delivery = tasks.filter(task => task.scope === 'delivery');
      let state = 'IDLE';

      if (tasks.some(task => task.state === 'NEEDS_HUMAN')) {
        state = 'NEEDS_HUMAN';
      } else if (
        tasks.some(task => task.state === 'SYSTEM_BLOCKED')
        && tasks.some(task => task.stage === 'project_debugger' && task.input?.blockedTaskId && ['READY', 'WORKING', 'RESULT_READY'].includes(task.state))
      ) {
        state = 'RUNNING';
      } else if (tasks.some(task => task.state === 'SYSTEM_BLOCKED')) {
        state = 'FAILED';
      } else if (this.store.hasUnplannedPlanningRequests(this.projectId)) {
        state = 'PLANNING';
      } else if (delivery.length > 0 && delivery.every(task => ['DONE', 'OBSOLETE'].includes(task.state))) {
        state = 'SUCCEEDED';
        let durableProject = this.store.getProject(this.projectId);
        const completedVersion = Number.isInteger(durableProject.projectVersion) ? durableProject.projectVersion : 0;
        const activeVersion = Number.isInteger(durableProject.activeVersion)
          ? durableProject.activeVersion
          : Math.max(1, completedVersion + 1);
        if (activeVersion > completedVersion) {
          const completedAt = new Date().toISOString();
          durableProject = this.store.updateProject(this.projectId, durableProject.version, {
            projectVersion: activeVersion,
            activeVersion,
            versionHistory: [
              ...(durableProject.versionHistory ?? []),
              {
                version: activeVersion,
                completedAt,
                deliveryPlanVersion: durableProject.deliveryPlanVersion ?? null,
                deliveryRootTaskId: durableProject.deliveryRootTaskId ?? null,
              },
            ],
          });
          this.manager.setVersionState?.(this.projectId, {
            projectVersion: activeVersion,
            activeVersion,
          });
        }
      } else if (tasks.some(task => ['READY', 'WORKING', 'RESULT_READY', 'WAITING_REPLAN'].includes(task.state))) {
        state = 'RUNNING';
      }

      this.manager.setExecutionState(this.projectId, state);

      // SQLite is the durable runtime source of truth. Keep its DB checkpoint,
      // but never manufacture Git commits from scheduler/task-state churn.
      this.store.checkpoint();
    } catch (error) {
      this.manager.setExecutionState(this.projectId, 'FAILED');
      throw error;
    } finally {
      this.ticking = false;
    }
  }

  resumeSystemBlocked(reason = 'MANUAL_RESUME') {
    const recovered: string[] = [];
    for (const task of this.store.listTasks(this.projectId)) {
      if (task.state !== 'SYSTEM_BLOCKED') continue;
      const lastFailure = [...(task.history ?? [])]
        .reverse()
        .find((entry: any) => entry?.type === 'SYSTEM_INTERRUPTION');
      this.store.appendTaskHistory(task.id, task.version, {
        type: 'SYSTEM_RECOVERY',
        role: task.stage,
        reason,
        previousFailure: lastFailure?.failure ?? null,
        at: new Date().toISOString(),
      }, {
        state: 'READY',
        execution: null,
      });
      this.resources.release(task.id);
      recovered.push(task.id);
    }
    return recovered;
  }

  acknowledgeSystemDiagnosisOnResume(reason = 'MANUAL_RESUME_AFTER_SYSTEM_REPAIR') {
    const acknowledged: string[] = [];
    for (const task of this.store.listTasks(this.projectId)) {
      if (task.state !== 'NEEDS_HUMAN' || task.stage !== 'project_debugger' || !task.input?.blockedTaskId) continue;
      this.store.appendTaskHistory(task.id, task.version, {
        type: 'HUMAN_DECISION',
        decision: reason,
        systemRepairConfirmed: true,
        at: new Date().toISOString(),
      }, {
        state: 'DONE',
        execution: null,
      });
      acknowledged.push(task.id);
    }
    return acknowledged;
  }

  recoverRestartOrphanHumanGates(reason = 'MANUAL_RESUME_AFTER_RUNTIME_RESTART') {
    const recovered: string[] = [];
    for (const task of this.store.listTasks(this.projectId)) {
      if (task.state !== 'NEEDS_HUMAN' || task.stage !== 'project_debugger') continue;
      const evidence = restartOrphanEvidence(task);
      if (!evidence) continue;

      this.store.appendTaskHistory(task.id, task.version, {
        type: 'SYSTEM_RECOVERY',
        role: 'project_debugger',
        reason,
        previousFailure: evidence.restartOrphan.failure ?? 'AGENT_SESSION_RUN_NOT_FOUND',
        previousDebuggerOutcome: evidence.latestRoleResult.outcome,
        at: new Date().toISOString(),
      }, {
        stage: 'developer',
        state: 'READY',
        execution: null,
      });
      this.resources.release(task.id);
      recovered.push(task.id);
    }
    return recovered;
  }

  recoverLegacyHumanGates(reason = 'MANUAL_RESUME_LEGACY_HUMAN_GATE') {
    const recovered: string[] = [];
    for (const task of this.store.listTasks(this.projectId)) {
      if (task.state !== 'NEEDS_HUMAN') continue;
      const targetStage = legacyHumanGateTarget(task.stage, task);
      if (!targetStage) continue;

      this.store.appendTaskHistory(task.id, task.version, {
        type: 'SYSTEM_RECOVERY',
        role: task.stage,
        reason,
        previousStage: task.stage,
        targetStage,
        at: new Date().toISOString(),
      }, {
        stage: targetStage,
        state: 'READY',
        execution: null,
      });
      this.resources.release(task.id);
      recovered.push(task.id);
    }
    return recovered;
  }


  findAttempt(attemptId: string, role?: string) {
    const task = this.store.listTasks(this.projectId).find((item: any) =>
      item?.execution?.attemptId === attemptId
      || (item?.history ?? []).some((entry: any) =>
        entry?.type === 'ROLE_RESULT' && entry?.attemptId === attemptId && entry?.source === 'role_result_tool'
      )
    );
    if (!task) return null;
    if (role && task.stage !== role) {
      const matchingResult = (task.history ?? []).some((entry: any) =>
        entry?.type === 'ROLE_RESULT' && entry?.attemptId === attemptId && entry?.role === role
      );
      if (!matchingResult) return null;
    }
    return { projectId: this.projectId, taskId: task.id, role: role ?? task.stage, attemptId };
  }

  submitRoleResult({
    taskId,
    role,
    attemptId,
    payload,
  }: {
    taskId: string;
    role: string;
    attemptId: string;
    payload: {
      outcome: string;
      summary: string;
      keyPoints?: string[];
      artifacts?: string[];
      result?: unknown;
    };
  }) {
    let task = this.store.getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.projectId !== this.projectId) throw new Error(`task ${taskId} does not belong to project ${this.projectId}`);
    if (task.stage !== role) throw new Error(`role result mismatch: task ${taskId} is at ${task.stage}, not ${role}`);
    if (task.state !== 'WORKING') {
      const existing = (task.history ?? []).find(
        (entry: any) => entry?.type === 'ROLE_RESULT'
          && entry?.attemptId === attemptId
          && entry?.role === role
          && entry?.source === 'role_result_tool'
      );
      if (existing) {
        this.resources.release(taskId);
        return { accepted: true, sealed: true, alreadySubmitted: true, taskId, attemptId };
      }
      throw new Error(`task ${taskId} is not WORKING`);
    }
    if (task.execution?.attemptId !== attemptId) {
      throw new Error(`stale role result attempt for ${taskId}: expected ${task.execution?.attemptId ?? 'none'}, got ${attemptId}`);
    }

    const existing = (task.history ?? []).find(
      (entry: any) => entry?.type === 'ROLE_RESULT'
        && entry?.attemptId === attemptId
        && entry?.role === role
        && entry?.source === 'role_result_tool'
    );
    if (existing) {
      this.resources.release(taskId);
      return { accepted: true, sealed: true, alreadySubmitted: true, taskId, attemptId };
    }

    const effectivePayload = role === 'tester'
      ? aggregateTesterSubmission(task, payload)
      : payload;

    const entry = {
      type: 'ROLE_RESULT',
      role,
      outcome: effectivePayload.outcome,
      summary: effectivePayload.summary,
      keyPoints: structuredClone(effectivePayload.keyPoints ?? []),
      artifacts: structuredClone(effectivePayload.artifacts ?? []),
      result: structuredClone(effectivePayload.result ?? null),
      attemptId,
      source: 'role_result_tool',
      provenance: structuredClone(task.execution?.provenance ?? null),
      protocolVersion: task.execution?.protocolVersion ?? null,
      projectVersion: task.execution?.projectVersion ?? null,
      completedAt: new Date().toISOString(),
    };

    try {
      task = this.store.appendTaskHistory(task.id, task.version, entry, {
        state: 'RESULT_READY',
        execution: null,
        artifacts: [...(task.artifacts ?? []), ...(effectivePayload.artifacts ?? [])],
      });
    } catch (error) {
      if (!String((error as Error)?.message ?? error).includes('version conflict')) throw error;
      task = this.store.getTask(taskId);
      const raced = (task?.history ?? []).find(
        (item: any) => item?.type === 'ROLE_RESULT'
          && item?.attemptId === attemptId
          && item?.role === role
          && item?.source === 'role_result_tool'
      );
      if (!raced) throw error;
      if (task.state === 'WORKING') {
        task = this.store.updateTask(task.id, task.version, {
          state: 'RESULT_READY',
          execution: null,
          artifacts: [...(task.artifacts ?? []), ...(raced.artifacts ?? [])],
        });
      }
      this.resources.release(taskId);
      return { accepted: true, sealed: true, alreadySubmitted: true, taskId, attemptId };
    }
    this.resources.release(taskId);
    return { accepted: true, sealed: true, alreadySubmitted: false, taskId, attemptId };
  }

  submitDecision(decision: string) {
    const task = this.store.listTasks(this.projectId).find(item => item.state === 'NEEDS_HUMAN');
    if (!task) throw new Error('project has no pending human decision');
    const systemDiagnosis = task.stage === 'project_debugger' && Boolean(task.input?.blockedTaskId);
    this.store.appendTaskHistory(task.id, task.version, {
      type: 'HUMAN_DECISION',
      decision,
      at: new Date().toISOString(),
    }, {
      state: systemDiagnosis ? 'DONE' : 'READY',
    });
    this.manager.setExecutionState(this.projectId, systemDiagnosis ? 'FAILED' : 'IDLE');
    return {
      taskId: task.id,
      decision,
      ...(systemDiagnosis ? {
        systemDiagnosis: true,
        blockedTaskId: task.input?.blockedTaskId ?? null,
        nextStep: 'Repair the system manually, then explicitly resume the project.',
      } : {}),
    };
  }

  close() {
    // Do not release execution resources merely because the controller is
    // closing. An OpenClaw run may still be settling after stop/restart;
    // fail closed so a possibly-live local model cannot overlap a new run.
    this.store.close();
  }
}

export class AriadV2Service {
  private readonly manager: ProjectManager;
  private readonly provider: OpenClawV2Provider;
  private readonly pushSourceControl: boolean;
  private readonly logger: any;
  private readonly executionCapabilities: string[];
  private readonly executionProvenance: Record<string, unknown>;
  private readonly sharedResources: ResourcePool;
  private readonly onProjectEvent?: (project: any, type: 'NEEDS_HUMAN' | 'FAILED' | 'SUCCEEDED') => Promise<void> | void;
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly signals = new Map<string, SQLiteReconcileSignal>();
  private readonly trigger: ReconcileTrigger;
  private readonly externalWake: FileReconcileWake | null;

  constructor({
    manager,
    provider,
    pushSourceControl,
    logger,
    executionCapabilities = [],
    executionProvenance = {},
    onProjectEvent,
    reconcileWakePath = null,
  }: {
    manager: ProjectManager;
    provider: OpenClawV2Provider;
    pushSourceControl: boolean;
    logger?: any;
    executionCapabilities?: string[];
    executionProvenance?: Record<string, unknown>;
    onProjectEvent?: (project: any, type: 'NEEDS_HUMAN' | 'FAILED' | 'SUCCEEDED') => Promise<void> | void;
    reconcileWakePath?: string | null;
  }) {
    this.manager = manager;
    this.provider = provider;
    this.pushSourceControl = pushSourceControl;
    this.logger = logger;
    this.executionCapabilities = [...executionCapabilities];
    this.executionProvenance = structuredClone(executionProvenance);
    this.sharedResources = new ResourcePool({ 'local-llm': 1 });
    this.onProjectEvent = onProjectEvent;
    this.externalWake = reconcileWakePath
      ? new FileReconcileWake(reconcileWakePath, {
          onError: (error: unknown) => this.logger?.warn?.(
            `Ariad cross-process wake signal failed: ${error instanceof Error ? error.message : String(error)}`
          ),
        })
      : null;
    this.trigger = new ReconcileTrigger({
      reconcile: () => this.reconcile(),
      readGeneration: () => this.readGeneration(),
      safetyIntervalMs: 10 * 60 * 1000,
      onError: (error: unknown) => this.logger?.error?.(
        `Ariad event-driven reconcile failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
      ),
    });
  }

  private signalFor(project: any) {
    if (!project?.stateDb) return null;
    let signal = this.signals.get(project.id);
    if (!signal) {
      signal = new SQLiteReconcileSignal(project.stateDb);
      this.signals.set(project.id, signal);
    }
    return signal;
  }

  private readGeneration() {
    let generation = 0;
    for (const project of this.manager.list()) generation += this.signalFor(project)?.read() ?? 0;
    return generation;
  }

  private wake(reason: string) {
    const acceptedLocally = this.trigger.wake(reason);
    if (!acceptedLocally) this.externalWake?.emit(reason);
  }

  async start() {
    this.externalWake?.start(() => {
      this.trigger.wake('external-process');
    });
    await this.reconcile();
    this.trigger.start();
  }

  async stop() {
    this.externalWake?.stop();
    this.trigger.stop();
    for (const signal of this.signals.values()) signal.close();
    this.signals.clear();
    for (const runtime of this.runtimes.values()) runtime.close();
    this.runtimes.clear();
  }

  list() {
    return this.manager.list().map(project => this.status(project.id));
  }

  status(name: string) {
    const project = this.manager.status(name);
    const runtime = this.runtimes.get(project.id);
    if (runtime) {
      return {
        ...project,
        runtime: 'v2',
        ...runtime.status(),
      };
    }

    // Cold-start status must still expose durable task/human-decision state.
    // NEEDS_HUMAN projects are intentionally not auto-instantiated by reconcile,
    // so reading only manager metadata would hide the very gate operators need.
    if (project.stateDb && existsSync(project.stateDb)) {
      const store = new SQLiteV2Store(project.stateDb);
      try {
        return {
          ...project,
          runtime: 'v2',
          ...buildDurableRuntimeStatus(store, project.id),
        };
      } finally {
        store.close();
      }
    }

    return {
      ...project,
      runtime: 'v2',
    };
  }

  async iterate(name: string, request: string) {
    const current = this.manager.status(name);
    if (current.executionState !== 'SUCCEEDED') {
      throw new Error(`project ${current.id} must be SUCCEEDED before starting a new iteration`);
    }
    requireCompleteRoleModels(current.roleModels ?? {});
    this.manager.setDesiredState(name, 'RUNNING');
    this.manager.setExecutionState(name, 'PLANNING');
    let runtime = this.runtimes.get(current.id);
    if (!runtime) {
      runtime = new ProjectRuntime({
        manager: this.manager,
        project: this.manager.status(current.id),
        provider: this.provider,
        pushSourceControl: this.pushSourceControl,
        logger: this.logger,
        executionCapabilities: this.executionCapabilities,
        executionProvenance: this.executionProvenance,
        sharedResources: this.sharedResources,
        wakeScheduler: (reason: string) => this.wake(reason),
      });
      this.runtimes.set(current.id, runtime);
    }
    const result = runtime.beginIteration(request);
    // Do not dispatch role work synchronously from an operator/tool request.
    // OpenClaw request-scoped subagent runs inherit the caller's model-override
    // authority; Ariad role routing is plugin-owned background policy instead.
    // The background trigger will pick this durable planning intent up.
    this.wake('iterate');
    return { ...result, project: this.status(current.id) };
  }

  async ensureRunning(name: string) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    const project = this.manager.setDesiredState(name, 'RUNNING');
    if (['FAILED', 'SUCCEEDED'].includes(project.executionState)) {
      this.manager.setExecutionState(name, 'IDLE');
    }
    // Scheduling is deferred to the background trigger, outside the caller scope.
    this.wake('running');
    return this.status(name);
  }

  async ensurePaused(name: string) {
    const current = this.manager.status(name);
    if (current.desiredState === 'STOPPED') {
      throw new Error(`project ${current.id} is STOPPED; start or resume it before pausing`);
    }
    this.manager.setDesiredState(name, 'PAUSED');
    this.wake('paused');
    return this.status(name);
  }

  async ensureResumed(name: string) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    this.manager.setDesiredState(name, 'RUNNING');

    let recoveredTasks: string[] = [];
    if (['FAILED', 'NEEDS_HUMAN'].includes(current.executionState)) {
      let runtime = this.runtimes.get(current.id);
      if (!runtime) {
        runtime = new ProjectRuntime({
          manager: this.manager,
          project: this.manager.status(current.id),
          provider: this.provider,
          pushSourceControl: this.pushSourceControl,
          logger: this.logger,
          executionCapabilities: this.executionCapabilities,
          executionProvenance: this.executionProvenance,
          sharedResources: this.sharedResources,
          wakeScheduler: (reason: string) => this.wake(reason),
        });
        this.runtimes.set(current.id, runtime);
      }
      if (current.executionState === 'FAILED') {
        recoveredTasks = runtime.resumeSystemBlocked('MANUAL_RESUME_AFTER_FAILED_PROJECT');
      } else {
        const systemDiagnosisAcknowledged = runtime.acknowledgeSystemDiagnosisOnResume('MANUAL_RESUME_AFTER_SYSTEM_REPAIR');
        const systemRecovered = systemDiagnosisAcknowledged.length > 0
          ? runtime.resumeSystemBlocked('MANUAL_RESUME_AFTER_SYSTEM_REPAIR')
          : [];
        const restartRecovered = runtime.recoverRestartOrphanHumanGates('MANUAL_RESUME_AFTER_RUNTIME_RESTART');
        const legacyRecovered = runtime.recoverLegacyHumanGates('MANUAL_RESUME_LEGACY_HUMAN_GATE');
        recoveredTasks = [...new Set([...systemRecovered, ...restartRecovered, ...legacyRecovered])];
      }
      if (recoveredTasks.length > 0 || current.executionState === 'FAILED') {
        this.manager.setExecutionState(name, 'IDLE');
      }
    }

    // Resume records durable intent/recovery and wakes the background scheduler.
    this.wake('resumed');
    return { ...this.status(name), recoveredTasks };
  }

  async ensureStopped(name: string) {
    this.manager.setDesiredState(name, 'STOPPED');
    const runtime = this.runtimes.get(name);
    if (runtime) {
      runtime.close();
      this.runtimes.delete(name);
    }
    this.wake('stopped');
    return this.status(name);
  }

  submitRoleResultByAttempt(attemptId: string, role: string, payload: {
    outcome: string;
    summary: string;
    keyPoints?: string[];
    artifacts?: string[];
    result?: unknown;
  }) {
    for (const runtime of this.runtimes.values()) {
      const binding = runtime.findAttempt(attemptId, role);
      if (binding) {
        const result = runtime.submitRoleResult({ ...binding, payload });
        this.wake('role-result');
        return result;
      }
    }

    for (const project of this.manager.list()) {
      if (!['RUNNING', 'PAUSED'].includes(project.desiredState)) continue;
      let runtime = this.runtimes.get(project.id);
      if (!runtime) {
        runtime = new ProjectRuntime({
          manager: this.manager,
          project,
          provider: this.provider,
          pushSourceControl: this.pushSourceControl,
          logger: this.logger,
          executionCapabilities: this.executionCapabilities,
          executionProvenance: this.executionProvenance,
          sharedResources: this.sharedResources,
          wakeScheduler: (reason: string) => this.wake(reason),
        });
        this.runtimes.set(project.id, runtime);
      }
      const binding = runtime.findAttempt(attemptId, role);
      if (binding) {
        const result = runtime.submitRoleResult({ ...binding, payload });
        this.wake('role-result');
        return result;
      }
    }
    throw new Error(`No durable Ariad role execution matches attemptId ${attemptId}.`);
  }

  submitRoleResult(binding: {
    projectId: string;
    taskId: string;
    role: string;
    attemptId: string;
  }, payload: {
    outcome: string;
    summary: string;
    keyPoints?: string[];
    artifacts?: string[];
    result?: unknown;
  }) {
    const project = this.manager.status(binding.projectId);
    let runtime = this.runtimes.get(project.id);
    if (!runtime) {
      if (!['RUNNING', 'PAUSED'].includes(project.desiredState)) throw new Error(`project ${project.id} is not running or paused`);
      runtime = new ProjectRuntime({
        manager: this.manager,
        project,
        provider: this.provider,
        pushSourceControl: this.pushSourceControl,
        logger: this.logger,
        executionCapabilities: this.executionCapabilities,
        executionProvenance: this.executionProvenance,
        sharedResources: this.sharedResources,
        wakeScheduler: (reason: string) => this.wake(reason),
      });
      this.runtimes.set(project.id, runtime);
    }
    const result = runtime.submitRoleResult({
      taskId: binding.taskId,
      role: binding.role,
      attemptId: binding.attemptId,
      payload,
    });
    this.wake('role-result');
    return result;
  }

  async submitDecision(name: string, decision: string) {
    const project = this.manager.status(name);
    let runtime = this.runtimes.get(project.id);
    if (!runtime) {
      runtime = new ProjectRuntime({
        manager: this.manager,
        project,
        provider: this.provider,
        pushSourceControl: this.pushSourceControl,
        logger: this.logger,
        executionCapabilities: this.executionCapabilities,
        executionProvenance: this.executionProvenance,
        sharedResources: this.sharedResources,
        wakeScheduler: (reason: string) => this.wake(reason),
      });
      this.runtimes.set(project.id, runtime);
    }
    const resumed = runtime.submitDecision(decision);
    this.wake('human-decision');
    return { resumed, project: this.status(project.id) };
  }

  async reconcile() {
    // ReconcileTrigger owns single-flight after startup. Do not add another
    // "already reconciling" guard here: a guard can turn a queued wake into a
    // successful no-op and lose durable work at the drain boundary.
    for (let project of this.manager.list()) {
        if (project.desiredState === 'STOPPED') {
          const existing = this.runtimes.get(project.id);
          if (existing) {
            existing.close();
            this.runtimes.delete(project.id);
          }
          continue;
        }

        if (project.executionState === 'NEEDS_HUMAN' && project.stateDb && existsSync(project.stateDb)) {
          const migrationStore = new SQLiteV2Store(project.stateDb);
          try {
            ensureTakeoverReviewState(migrationStore, project.id);
            const recovered = recoverObsoleteTakeoverHumanGates(migrationStore, project.id);
            if (recovered.length > 0) {
              this.manager.setExecutionState(project.id, 'IDLE');
              project = this.manager.status(project.id);
              this.logger?.info?.(
                `Ariad recovered obsolete repeated TAKEOVER gate(s) for ${project.id}: ${recovered.join(', ')}`
              );
            }
          } finally {
            migrationStore.close();
          }
        }

        if (['SUCCEEDED', 'FAILED', 'NEEDS_HUMAN'].includes(project.executionState)) continue;

        let runtime = this.runtimes.get(project.id);
        if (!runtime) {
          runtime = new ProjectRuntime({
            manager: this.manager,
            project,
            provider: this.provider,
            pushSourceControl: this.pushSourceControl,
            logger: this.logger,
            executionCapabilities: this.executionCapabilities,
            executionProvenance: this.executionProvenance,
            sharedResources: this.sharedResources,
            wakeScheduler: (reason: string) => this.wake(reason),
          });
          this.runtimes.set(project.id, runtime);
        }

        try {
          await runtime.tick({ schedule: project.desiredState === 'RUNNING' });
          const updated = this.manager.status(project.id);
          if (
            updated.executionState !== project.executionState &&
            ['NEEDS_HUMAN', 'FAILED', 'SUCCEEDED'].includes(updated.executionState)
          ) {
            await this.onProjectEvent?.(this.status(project.id), updated.executionState);
          }
        } catch (error) {
          this.logger?.error?.(
            `Ariad v2 project ${project.id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
          );
          const updated = this.manager.status(project.id);
          if (updated.executionState === 'FAILED' && project.executionState !== 'FAILED') {
            await this.onProjectEvent?.(updated, 'FAILED');
          }
        }
      }
  }
}
