import type { AriadProjectManager, AriadProjectStatus } from '../runtime/project-manager.js';

export interface ProjectController {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  status?(): unknown;
}

type SupervisorOptions = {
  manager: AriadProjectManager;
  createController: (project: AriadProjectStatus) => ProjectController;
};

export class AriadSupervisor {
  private readonly manager: AriadProjectManager;
  private readonly createController: SupervisorOptions['createController'];
  private readonly controllers = new Map<string, ProjectController>();
  private started = false;

  constructor(options: SupervisorOptions) {
    this.manager = options.manager;
    this.createController = options.createController;
  }

  async start() {
    this.started = true;
    for (const project of this.manager.list()) {
      if (project.desiredState === 'RUNNING') await this.ensureRunning(project.id);
    }
  }

  async stop() {
    this.started = false;
    const entries = [...this.controllers.entries()];
    this.controllers.clear();
    await Promise.all(entries.map(async ([, controller]) => controller.stop()));
  }

  async ensureRunning(name: string) {
    const project = this.manager.setDesiredState(name, 'RUNNING');
    let controller = this.controllers.get(project.id);
    if (!controller) {
      controller = this.createController(project);
      this.controllers.set(project.id, controller);
      await controller.start();
    }
    return this.status(project.id);
  }

  async ensureStopped(name: string) {
    const project = this.manager.setDesiredState(name, 'STOPPED');
    const controller = this.controllers.get(project.id);
    if (controller) {
      await controller.stop();
      this.controllers.delete(project.id);
    }
    return this.status(project.id);
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
