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
      artifactRoot: this.artifactRoot,
      executionCapabilities,
      executionProvenance,
      resolveRoleExecutionMetadata: role => ({
        modelRef: this.resolveRoleModel(role) ?? null,
      }),
      enqueuePlanning: ({ request }) => {
        this.store.enqueuePlanningRequest({
          id: `${project.id}:replan:${Date.now()}:${++this.requestSequence}`,
          projectId: project.id,
          request,
        });
      },
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

  async tick({ schedule = true } = {}) {
    const audit = await this.supervisor.audit(this.projectId);
    const scheduled = schedule ? await this.scheduler.tick(this.projectId) : { started: [] };
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

  status() {
    const tasks = this.store.listTasks(this.projectId);
    const project = this.store.getProject(this.projectId);
    return {
      projectId: this.projectId,
      deliveryEnabled: project?.deliveryEnabled === true,
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
    this.store.close();
  }
}
