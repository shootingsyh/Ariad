import { join } from 'node:path';
import { ARIAD_MODEL_ROLES, normalizeRoleModels } from './role-models.js';
import { queryInterfaces } from '../v2/interface-query.js';
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

  interfaces(name, { interfaceId = null } = {}) {
    if (!name) throw new Error('project name is required');
    const project = this.manager.status(name);
    const workspace = project.workspace ?? join(this.manager.projectsRoot, name, 'workspace');
    const result = queryInterfaces(join(workspace, '.ariad', 'artifacts'), { interfaceId });
    return { project: name, ...result };
  }

  setUxReview(name, uxReview) {
    if (!name) throw new Error('project name is required');
    return this.manager.setUxReview(name, uxReview);
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

  start(name, audit = {}) {
    return this.service.ensureRunning(name, audit);
  }

  pause(name, audit = {}) {
    return this.service.ensurePaused(name, audit);
  }

  softStop(name, audit = {}) {
    return this.service.ensurePaused(name, { ...audit, action: 'SOFT_STOP' });
  }


  resume(name, audit = {}) {
    return this.service.ensureResumed(name, audit);
  }

  stop(name, audit = {}) {
    return this.service.ensureStopped(name, audit);
  }

  openIssue(name, issue) {
    return this.service.openIssue(name, issue);
  }

  listIssues(name, states = null) {
    return this.service.listIssues(name, states);
  }

  async execute(action, input = {}) {
    switch (action) {
      case 'list': return this.list();
      case 'status': return this.status(input.name);
      case 'models': return this.models(input.name ?? null);
      case 'interfaces': return this.interfaces(input.name, { interfaceId: input.interfaceId ?? null });
      case 'set_role_models': return this.setRoleModels(input.name, input.roleModels);
      case 'set_ux_review': return this.setUxReview(input.name, input.uxReview);
      case 'create': return this.create(input);
      case 'takeover': return this.takeover(input);
      case 'adopt': return this.adopt(input);
      case 'start': return this.start(input.name, { source: input.auditSource ?? 'unknown-client', requestId: input.requestId ?? null });
      case 'pause': return this.pause(input.name, { source: input.auditSource ?? 'unknown-client', requestId: input.requestId ?? null });
      case 'soft_stop': return this.softStop(input.name, { source: input.auditSource ?? 'unknown-client', requestId: input.requestId ?? null });
      case 'resume': return this.resume(input.name, { source: input.auditSource ?? 'unknown-client', requestId: input.requestId ?? null });
      case 'stop': return this.stop(input.name, { source: input.auditSource ?? 'unknown-client', requestId: input.requestId ?? null });
      case 'open_issue': return this.openIssue(input.name, input.issue ?? input);
      case 'list_issues': return this.listIssues(input.name, input.states ?? null);
      default: throw new Error(`unknown Ariad control action: ${action}`);
    }
  }
}

export function createAriadControlTools(options) {
  return new AriadControlTools(options);
}
