import { readdirSync } from 'node:fs';
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

type ProjectManager = {
  list(): any[];
  status(name: string): any;
  setDesiredState(name: string, state: string): any;
  setExecutionState(name: string, state: string): any;
};

function workspaceIsEmpty(path: string) {
  return readdirSync(path, { withFileTypes: true }).every(entry => entry.name === '.git');
}

class ProjectRuntime {
  private readonly manager: ProjectManager;
  private readonly projectId: string;
  private readonly store: SQLiteV2Store;
  private readonly scheduler: V2Scheduler;
  private readonly supervisor: V2Supervisor;
  private ticking = false;
  private requestSequence = 0;

  constructor({
    manager,
    project,
    provider,
    pushSourceControl,
  }: {
    manager: ProjectManager;
    project: any;
    provider: OpenClawV2Provider;
    pushSourceControl: boolean;
  }) {
    this.manager = manager;
    this.projectId = project.id;
    this.store = new SQLiteV2Store(project.stateDb);

    if (!this.store.getProject(project.id)) {
      this.store.createProject({
        id: project.id,
        spec: project.goal ?? null,
        workspace: project.workspace,
        pmBinding: `pm:${project.id}`,
      });
    }

    const providers = new ProviderRegistry();
    providers.register(provider);
    providers.register(new FunctionProvider());

    const resources = new ResourcePool({});
    const sourceControl = new GitSourceControlFinalizer({
      workspace: project.workspace,
      push: pushSourceControl,
    });

    const roleRegistry = new RoleRegistry();
    const roleDefinitions = (createDefaultV2Roles as any)({
      store: this.store,
      providerId: provider.id,
      codeProviderId: 'ariad-code',
      workspace: project.workspace,
      sourceControl,
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
      resources,
    });
    this.supervisor = new V2Supervisor({
      store: this.store,
      providers,
      resources,
    });
    this.supervisor.recover(project.id);

    const hasTasks = this.store.listTasks(project.id).length > 0;
    const hasPlanning = this.store.listPlanningRequests(project.id).length > 0;
    if (!hasTasks && !hasPlanning) {
      const empty = workspaceIsEmpty(project.workspace);
      if (empty) {
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
        .map(task => ({ id: task.id, stage: task.stage, state: task.state })),
    };
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.supervisor.audit(this.projectId);
      await this.scheduler.tick(this.projectId);

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
    } catch (error) {
      this.manager.setExecutionState(this.projectId, 'FAILED');
      throw error;
    } finally {
      this.ticking = false;
    }
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
    const project = this.manager.setDesiredState(name, 'RUNNING');
    if (['FAILED', 'SUCCEEDED'].includes(project.executionState)) {
      this.manager.setExecutionState(name, 'IDLE');
    }
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

  async submitDecision(name: string, decision: string) {
    const project = this.manager.status(name);
    let runtime = this.runtimes.get(project.id);
    if (!runtime) {
      runtime = new ProjectRuntime({
        manager: this.manager,
        project,
        provider: this.provider,
        pushSourceControl: this.pushSourceControl,
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
        if (project.desiredState !== 'RUNNING') {
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
          });
          this.runtimes.set(project.id, runtime);
        }

        try {
          await runtime.tick();
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
