import { HumanDecisionResumer } from '../runtime/human-decision-resumer.js';
import type { AriadProjectManager, AriadProjectStatus } from '../runtime/project-manager.js';

export interface ProjectController {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  status?(): unknown;
}

type SupervisorOptions = {
  manager: AriadProjectManager;
  createController: (project: AriadProjectStatus) => ProjectController;
  reconcileIntervalMs?: number;
};

export class AriadSupervisor {
  private readonly manager: AriadProjectManager;
  private readonly createController: SupervisorOptions['createController'];
  private readonly reconcileIntervalMs: number;
  private readonly controllers = new Map<string, ProjectController>();
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconcilePromise: Promise<void> | null = null;

  constructor(options: SupervisorOptions) {
    this.manager = options.manager;
    this.createController = options.createController;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 250;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile();
    }, this.reconcileIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reconcilePromise) await this.reconcilePromise;
    const entries = [...this.controllers.entries()];
    this.controllers.clear();
    await Promise.all(entries.map(async ([, controller]) => controller.stop()));
  }

  async ensureRunning(name: string) {
    const project = this.manager.setDesiredState(name, 'RUNNING');
    return this.status(project.id);
  }

  async ensureStopped(name: string) {
    const project = this.manager.setDesiredState(name, 'STOPPED');
    return this.status(project.id);
  }

  async submitDecision(name: string, decision: string) {
    const project = this.manager.setDesiredState(name, 'RUNNING');
    const current = this.controllers.get(project.id);
    if (current) {
      await current.stop();
      this.controllers.delete(project.id);
    }

    const resumed = new HumanDecisionResumer({ project }).submit(decision);
    const nextProject = this.manager.status(project.id);
    const next = this.createController(nextProject);
    this.controllers.set(project.id, next);
    await next.start();
    return { resumed, project: this.status(project.id) };
  }

  async reconcile() {
    if (!this.started) return;
    if (this.reconcilePromise) return this.reconcilePromise;

    this.reconcilePromise = (async () => {
      for (const project of this.manager.list()) {
        const controller = this.controllers.get(project.id);
        if (project.desiredState === 'RUNNING' && !controller) {
          const next = this.createController(project);
          this.controllers.set(project.id, next);
          await next.start();
        } else if (project.desiredState === 'STOPPED' && controller) {
          await controller.stop();
          this.controllers.delete(project.id);
        }
      }
    })().finally(() => {
      this.reconcilePromise = null;
    });

    return this.reconcilePromise;
  }

  status(name: string) {
    const project = this.manager.status(name);
    const controller = this.controllers.get(project.id);
    return {
      ...project,
      active: Boolean(controller),
      controller: controller?.status?.() ?? null,
      supervisorStarted: this.started,
    };
  }

  list() {
    return this.manager.list().map((project) => this.status(project.id));
  }
}
