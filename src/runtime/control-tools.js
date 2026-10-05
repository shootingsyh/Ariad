export class AriadControlTools {
  constructor({ manager, service }) {
    if (!manager) throw new Error('AriadControlTools requires manager');
    if (!service) throw new Error('AriadControlTools requires service');
    this.manager = manager;
    this.service = service;
  }

  list() {
    return this.service.list();
  }

  status(name) {
    return this.service.status(name);
  }

  create({ name, goal = null, roleModels, mode = 'NEW', sourcePath = null } = {}) {
    if (!name) throw new Error('project name is required');
    const project = this.manager.create(name, { goal, roleModels, mode, sourcePath });
    return this.service.status(project.id);
  }

  takeover({ name, sourcePath, goal = null, roleModels } = {}) {
    if (!sourcePath) throw new Error('sourcePath is required for takeover');
    return this.create({ name, sourcePath, goal, roleModels, mode: 'TAKEOVER' });
  }

  adopt({ name, sourcePath, roleModels = null } = {}) {
    if (!name) throw new Error('project name is required');
    if (!sourcePath) throw new Error('sourcePath is required for adopt');
    return this.manager.adopt(name, sourcePath, { roleModels });
  }

  start(name) {
    return this.service.ensureRunning(name);
  }

  pause(name) {
    return this.service.ensurePaused(name);
  }

  resume(name) {
    return this.service.ensureResumed(name);
  }

  stop(name) {
    return this.service.ensureStopped(name);
  }

  async execute(action, input = {}) {
    switch (action) {
      case 'list': return this.list();
      case 'status': return this.status(input.name);
      case 'create': return this.create(input);
      case 'takeover': return this.takeover(input);
      case 'adopt': return this.adopt(input);
      case 'start': return this.start(input.name);
      case 'pause': return this.pause(input.name);
      case 'resume': return this.resume(input.name);
      case 'stop': return this.stop(input.name);
      default: throw new Error(`unknown Ariad control action: ${action}`);
    }
  }
}

export function createAriadControlTools(options) {
  return new AriadControlTools(options);
}
