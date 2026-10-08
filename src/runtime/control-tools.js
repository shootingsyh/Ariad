import { ARIAD_MODEL_ROLES, normalizeRoleModels } from './role-models.js';
import { ARIAD_PI_SPECIAL_NEEDS } from './pi-runtime-config.js';

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

  models(name = null) {
    const project = name ? this.manager.status(name) : null;
    return {
      requiredRoles: ARIAD_MODEL_ROLES,
      providerNamespaces: [...ARIAD_PI_SPECIAL_NEEDS.hostedProviders, 'llamacpp'],
      modelRefFormat: 'provider/model',
      roleModels: project?.roleModels ?? null,
      missingRoles: project
        ? ARIAD_MODEL_ROLES.filter(role => !project.roleModels?.[role])
        : null,
    };
  }

  setRoleModels(name, roleModels) {
    if (!name) throw new Error('project name is required');
    const normalized = normalizeRoleModels(roleModels ?? {});
    if (Object.keys(normalized).length === 0) throw new Error('roleModels is required');
    return this.manager.setRoleModels(name, normalized);
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

  softStop(name) {
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
      case 'models': return this.models(input.name ?? null);
      case 'set_role_models': return this.setRoleModels(input.name, input.roleModels);
      case 'create': return this.create(input);
      case 'takeover': return this.takeover(input);
      case 'adopt': return this.adopt(input);
      case 'start': return this.start(input.name);
      case 'pause': return this.pause(input.name);
      case 'soft_stop': return this.softStop(input.name);
      case 'resume': return this.resume(input.name);
      case 'stop': return this.stop(input.name);
      default: throw new Error(`unknown Ariad control action: ${action}`);
    }
  }
}

export function createAriadControlTools(options) {
  return new AriadControlTools(options);
}
