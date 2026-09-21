import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GitSourceControlFinalizer } from '../../../src/git-source-control-finalizer.js';
import { SQLiteV2Store } from '../../../src/v2/sqlite-store.js';
import { RoleRegistry } from '../../../src/v2/role-registry.js';
import { ProviderRegistry } from '../../../src/v2/provider-registry.js';
import { ResourcePool } from '../../../src/v2/resource-pool.js';
import { V2Scheduler } from '../../../src/v2/scheduler.js';
import { V2Supervisor } from '../../../src/v2/supervisor.js';
import { FunctionProvider } from '../../../src/v2/function-provider.js';
import { createDefaultV2Roles } from '../../../src/v2/default-roles.js';
import { bootstrapProject } from '../../../src/v2/project-bootstrap.js';
import type { OpenClawV2Provider } from './openclaw-v2-provider.js';
import { requireCompleteRoleModels } from '../runtime/role-models.js';

type ProjectManager = {
  list(): any[];
  status(name: string): any;
  setDesiredState(name: string, state: string): any;
  setExecutionState(name: string, state: string): any;
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
  private readonly resources: ResourcePool;
  private readonly sourceControl: GitSourceControlFinalizer;
  private readonly logger: any;
  private ticking = false;
  private requestSequence = 0;

  constructor({
    manager,
    project,
    provider,
    pushSourceControl,
    logger,
  }: {
    manager: ProjectManager;
    project: any;
    provider: OpenClawV2Provider;
    pushSourceControl: boolean;
    logger?: any;
  }) {
    this.manager = manager;
    this.logger = logger;
    this.projectId = project.id;
    this.store = new SQLiteV2Store(project.stateDb);

    if (!this.store.getProject(project.id)) {
      this.store.createProject({
        id: project.id,
        spec: project.goal ?? null,
        mode: project.mode ?? 'NEW',
        sourcePath: project.sourcePath ?? null,
        workspace: project.workspace,
        pmBinding: `pm:${project.id}`,
      });
    }

    const providers = new ProviderRegistry();
    providers.register(provider);
    providers.register(new FunctionProvider());

    this.resources = new ResourcePool({});
    this.sourceControl = new GitSourceControlFinalizer({
      workspace: project.workspace,
      push: pushSourceControl,
    });

    const roleRegistry = new RoleRegistry();
    const roleDefinitions = (createDefaultV2Roles as any)({
      store: this.store,
      providerId: provider.id,
      codeProviderId: 'ariad-code',
      workspace: project.workspace,
      sourceControl: this.sourceControl,
      artifactRoot: join(project.workspace, '.ariad', 'artifacts'),
      enqueuePlanning: ({ request }: any) => {
        const id = `${project.id}:replan:${Date.now()}:${++this.requestSequence}`;
        this.store.enqueuePlanningRequest({
          id,
          projectId: project.id,
          request,
        });
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

  status() {
    const tasks = this.store.listTasks(this.projectId);
    const planning = this.store.listPlanningRequests(this.projectId);
    return {
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
    };
  }

  async tick({ schedule = true }: { schedule?: boolean } = {}) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.supervisor.audit(this.projectId);
      if (schedule) await this.scheduler.tick(this.projectId);

      const tasks = this.store.listTasks(this.projectId);
      const delivery = tasks.filter(task => task.scope === 'delivery');
      let state = 'IDLE';

      if (tasks.some(task => task.state === 'SYSTEM_BLOCKED')) {
        state = 'FAILED';
      } else if (tasks.some(task => task.state === 'NEEDS_HUMAN')) {
        state = 'NEEDS_HUMAN';
      } else if (this.store.hasUnplannedPlanningRequests(this.projectId)) {
        state = 'PLANNING';
      } else if (delivery.length > 0 && delivery.every(task => ['DONE', 'OBSOLETE'].includes(task.state))) {
        state = 'SUCCEEDED';
      } else if (tasks.some(task => ['READY', 'WORKING', 'RESULT_READY', 'WAITING_REPLAN'].includes(task.state))) {
        state = 'RUNNING';
      }

      this.manager.setExecutionState(this.projectId, state);

      // Persist runtime truth as a Git snapshot without touching unfinished product changes.
      // Reviewer PASS performs the full-repository finalize separately.
      this.store.checkpoint();
      const checkpoint = await this.sourceControl.checkpointState({
        label: `${this.projectId} ${state.toLowerCase()}`,
      });
      if (!checkpoint.ok) {
        this.logger?.warn?.(
          `Ariad state checkpoint for ${this.projectId} was committed locally but not fully replicated: ${checkpoint.failure ?? 'unknown Git failure'}`
        );
      }
    } catch (error) {
      this.manager.setExecutionState(this.projectId, 'FAILED');
      throw error;
    } finally {
      this.ticking = false;
    }
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
      task = this.store.appendTaskHistory(task.id, task.version, entry, {
        state: 'RESULT_READY',
        execution: null,
        artifacts: [...(task.artifacts ?? []), ...(payload.artifacts ?? [])],
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
    this.store.appendTaskHistory(task.id, task.version, {
      type: 'HUMAN_DECISION',
      decision,
      at: new Date().toISOString(),
    }, {
      state: 'READY',
    });
    this.manager.setExecutionState(this.projectId, 'IDLE');
    return { taskId: task.id, decision };
  }

  close() {
    this.store.close();
  }
}

export class AriadV2Service {
  private readonly manager: ProjectManager;
  private readonly provider: OpenClawV2Provider;
  private readonly pushSourceControl: boolean;
  private readonly logger: any;
  private readonly onProjectEvent?: (project: any, type: 'NEEDS_HUMAN' | 'FAILED' | 'SUCCEEDED') => Promise<void> | void;
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor({
    manager,
    provider,
    pushSourceControl,
    logger,
    onProjectEvent,
  }: {
    manager: ProjectManager;
    provider: OpenClawV2Provider;
    pushSourceControl: boolean;
    logger?: any;
    onProjectEvent?: (project: any, type: 'NEEDS_HUMAN' | 'FAILED' | 'SUCCEEDED') => Promise<void> | void;
  }) {
    this.manager = manager;
    this.provider = provider;
    this.pushSourceControl = pushSourceControl;
    this.logger = logger;
    this.onProjectEvent = onProjectEvent;
  }

  async start() {
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 250);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const runtime of this.runtimes.values()) runtime.close();
    this.runtimes.clear();
  }

  list() {
    return this.manager.list().map(project => this.status(project.id));
  }

  status(name: string) {
    const project = this.manager.status(name);
    const runtime = this.runtimes.get(project.id);
    return {
      ...project,
      runtime: 'v2',
      ...(runtime ? runtime.status() : {}),
    };
  }

  async ensureRunning(name: string) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    const project = this.manager.setDesiredState(name, 'RUNNING');
    if (['FAILED', 'SUCCEEDED'].includes(project.executionState)) {
      this.manager.setExecutionState(name, 'IDLE');
    }
    await this.reconcile();
    return this.status(name);
  }

  async ensurePaused(name: string) {
    const current = this.manager.status(name);
    if (current.desiredState === 'STOPPED') {
      throw new Error(`project ${current.id} is STOPPED; start or resume it before pausing`);
    }
    this.manager.setDesiredState(name, 'PAUSED');
    await this.reconcile();
    return this.status(name);
  }

  async ensureResumed(name: string) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    this.manager.setDesiredState(name, 'RUNNING');
    await this.reconcile();
    return this.status(name);
  }

  async ensureStopped(name: string) {
    this.manager.setDesiredState(name, 'STOPPED');
    const runtime = this.runtimes.get(name);
    if (runtime) {
      runtime.close();
      this.runtimes.delete(name);
    }
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
      if (binding) return runtime.submitRoleResult({ ...binding, payload });
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
        });
        this.runtimes.set(project.id, runtime);
      }
      const binding = runtime.findAttempt(attemptId, role);
      if (binding) return runtime.submitRoleResult({ ...binding, payload });
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
      });
      this.runtimes.set(project.id, runtime);
    }
    return runtime.submitRoleResult({
      taskId: binding.taskId,
      role: binding.role,
      attemptId: binding.attemptId,
      payload,
    });
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
      });
      this.runtimes.set(project.id, runtime);
    }
    const resumed = runtime.submitDecision(decision);
    return { resumed, project: this.status(project.id) };
  }

  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const project of this.manager.list()) {
        if (project.desiredState === 'STOPPED') {
          const existing = this.runtimes.get(project.id);
          if (existing) {
            existing.close();
            this.runtimes.delete(project.id);
          }
          continue;
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
            await this.onProjectEvent?.(updated, updated.executionState);
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
    } finally {
      this.reconciling = false;
    }
  }
}
