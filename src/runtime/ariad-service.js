import { existsSync } from 'node:fs';

import { ResourcePool } from '../v2/resource-pool.js';
import { ReconcileTrigger } from '../v2/reconcile-trigger.js';
import { SQLiteReconcileSignal } from '../v2/sqlite-reconcile-signal.js';
import { FileReconcileWake } from '../v2/file-reconcile-wake.js';
import { SQLiteV2Store } from '../v2/sqlite-store.js';
import { isAdhocAnalysis } from '../v2/control-task-policy.js';
import { activateDeferredIterations } from '../v2/deferred-iterations.js';
import { recoverPrematureMigrationApprovalGate } from '../v2/migration-gate-recovery.js';
import { requireCompleteRoleModels } from './role-models.js';
import { MemoryCurator } from './memory-curator.js';
import { StandaloneProjectRuntime } from './standalone-project-runtime.js';
import { PROJECT_CONTROL_MACHINE, deriveProjectExecutionState } from '../v2/state-machine.js';
import {
  createProjectCodeIntelligence,
  inspectProjectCodeCapabilities,
  requireRuntimeDependencies,
} from './code-intelligence/project-capabilities.js';
import { join } from 'node:path';
import {
  migratePlanningModelDatabase,
  planningModelMigrationStatus,
} from '../v2/version-migration.js';

export class AriadService {
  constructor({
    manager,
    provider,
    logger = null,
    sharedResources = new ResourcePool({ 'local-llm': 1 }),
    reconcileWakePath = null,
    safetyIntervalMs = 10 * 60 * 1000,
    onProjectEvent = null,
    memoryCurator = null,
  }) {
    if (!manager) throw new Error('AriadService requires manager');
    if (!provider) throw new Error('AriadService requires provider');
    this.manager = manager;
    this.provider = provider;
    this.logger = logger;
    this.sharedResources = sharedResources;
    this.onProjectEvent = onProjectEvent;
    this.memoryCurator = memoryCurator ?? (provider?.id === 'pi-agent-session' ? new MemoryCurator({ provider, logger }) : null);
    this.runtimes = new Map();
    this.signals = new Map();
    this.codeCapabilities = new Map();

    this.externalWake = reconcileWakePath
      ? new FileReconcileWake(reconcileWakePath, {
          onError: error => this.logger?.warn?.(
            `Ariad cross-process wake failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        })
      : null;

    this.trigger = new ReconcileTrigger({
      reconcile: () => this.reconcile(),
      readGeneration: () => this.readGeneration(),
      safetyIntervalMs,
      onError: error => this.logger?.error?.(
        `Ariad reconcile failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      ),
    });
  }

  signalFor(project) {
    if (!project?.stateDb || !existsSync(project.stateDb)) return null;
    let signal = this.signals.get(project.id);
    if (!signal) {
      signal = new SQLiteReconcileSignal(project.stateDb);
      this.signals.set(project.id, signal);
    }
    return signal;
  }

  readGeneration() {
    let generation = 0;
    for (const project of this.manager.list()) {
      generation += this.signalFor(project)?.read() ?? 0;
    }
    return generation;
  }

  wake(reason = 'event') {
    const accepted = this.trigger.wake(reason);
    if (!accepted) this.externalWake?.emit(reason);
    return accepted;
  }

  async start() {
    this.externalWake?.start(() => this.trigger.wake('external-process'));
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
    await this.memoryCurator?.close?.();
    await this.provider.close?.();
  }

  runtimeFor(project) {
    let runtime = this.runtimes.get(project.id);
    if (!runtime) {
      const capabilities = this.codeCapabilities.get(project.id)
        ?? inspectProjectCodeCapabilities(project.workspace);
      this.codeCapabilities.set(project.id, capabilities);
      const codeIntelligence = createProjectCodeIntelligence(project, capabilities);
      runtime = new StandaloneProjectRuntime({
        project,
        provider: this.provider,
        sharedResources: this.sharedResources,
        codeIntelligence,
        resolveRoleModel: role => this.manager.status(project.id).roleModels?.[role] ?? null,
      });
      this.runtimes.set(project.id, runtime);
    }
    return runtime;
  }

  list() {
    return this.manager.list().map(project => this.status(project.id));
  }

  status(name) {
    const project = this.manager.status(name);
    const runtime = this.runtimes.get(project.id);
    if (runtime) return {
      ...project,
      runtime: 'standalone',
      codeCapabilities: this.codeCapabilities.get(project.id) ?? null,
      ...runtime.status(),
    };

    if (project.stateDb && existsSync(project.stateDb)) {
      const store = new SQLiteV2Store(project.stateDb);
      try {
        const tasks = store.listTasks(project.id);
        const durableProject = store.getProject(project.id);
        return {
          ...project,
          runtime: 'standalone',
          codeCapabilities: this.codeCapabilities.get(project.id) ?? null,
          storageVersion: durableProject?.storageVersion ?? 1,
          planningModelVersion: durableProject?.planningModelVersion ?? 1,
          planningModelMigration: planningModelMigrationStatus(durableProject),
          tasks: {
            total: tasks.length,
            ready: tasks.filter(task => task.state === 'READY').length,
            working: tasks.filter(task => task.state === 'WORKING').length,
            resultReady: tasks.filter(task => task.state === 'RESULT_READY').length,
            done: tasks.filter(task => task.state === 'DONE').length,
            blocked: tasks.filter(task => task.state === 'SYSTEM_BLOCKED').length,
            needsHuman: tasks.filter(task => task.state === 'NEEDS_HUMAN').length,
          },
        };
      } finally {
        store.close();
      }
    }
    return { ...project, runtime: 'standalone', codeCapabilities: this.codeCapabilities.get(project.id) ?? null };
  }

  async migratePlanningModel(name) {
    await this.ensureStopped(name);
    const project = this.manager.status(name);
    const migration = migratePlanningModelDatabase({
      stateDb: project.stateDb,
      projectId: project.id,
      artifactRoot: join(project.workspace, '.ariad', 'artifacts'),
    });
    if (!migration) return { ...this.status(name), migration: null };
    this.manager.setExecutionState(name, 'IDLE');
    this.wake('planning-model-migration');
    return { ...this.status(name), migration };
  }

  async ensureRunning(name) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    requireRuntimeDependencies();
    this.codeCapabilities.set(current.id, inspectProjectCodeCapabilities(current.workspace));
    const project = this.manager.setDesiredState(
      name,
      PROJECT_CONTROL_MACHINE.resolve(current.desiredState, 'START'),
    );
    if (['FAILED', 'SUCCEEDED'].includes(project.executionState)) {
      this.manager.setExecutionState(name, 'IDLE');
    }
    this.wake('running');
    return this.status(name);
  }

  async ensurePaused(name) {
    const current = this.manager.status(name);
    if (current.desiredState === 'STOPPED') {
      throw new Error(`project ${current.id} is STOPPED; start or resume it before pausing`);
    }
    this.manager.setDesiredState(
      name,
      PROJECT_CONTROL_MACHINE.resolve(current.desiredState, 'PAUSE'),
    );
    this.wake('paused');
    return this.status(name);
  }

  async ensureResumed(name) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    requireRuntimeDependencies();
    this.codeCapabilities.set(current.id, inspectProjectCodeCapabilities(current.workspace));
    this.manager.setDesiredState(
      name,
      PROJECT_CONTROL_MACHINE.resolve(current.desiredState, 'RESUME'),
    );
    let recoveredTasks = [];
    if (current.executionState === 'FAILED') {
      const runtime = this.runtimeFor(this.manager.status(name));
      recoveredTasks = runtime.resumeSystemBlocked('MANUAL_RESUME_AFTER_FAILED_PROJECT');
      this.manager.setExecutionState(name, 'IDLE');
    }
    this.wake('resumed');
    return { ...this.status(name), recoveredTasks };
  }

  async ensureStopped(name) {
    const current = this.manager.status(name);
    const project = this.manager.setDesiredState(
      name,
      PROJECT_CONTROL_MACHINE.resolve(current.desiredState, 'STOP'),
    );
    const runtime = this.runtimes.get(project.id);
    let cancelledTasks = [];
    if (runtime) {
      cancelledTasks = await runtime.cancelActive('PROJECT_STOPPED');
      runtime.close();
      this.runtimes.delete(project.id);
    }
    this.wake('stopped');
    return { ...this.status(name), cancelledTasks };
  }

  deriveExecutionState(runtime) {
    const tasks = runtime.store.listTasks(runtime.projectId);
    const hasPlanning = runtime.store.hasUnplannedPlanningRequests(runtime.projectId);
    const migration = runtime.store.getProject(runtime.projectId)?.planningModelMigration ?? null;
    return deriveProjectExecutionState({ tasks, hasPlanning, migration });
  }

  createOperatorAnalysis(name, { id, instruction }) {
    const project = this.manager.status(name);
    const runtime = this.runtimeFor(project);
    const task = runtime.store.createAdhocAnalysis({
      projectId: project.id,
      id,
      requestedBy: 'operator',
      instruction,
    });
    this.wake('operator-adhoc-analysis');
    return { projectId: project.id, taskId: task.id, taskKind: task.taskKind, state: task.state };
  }

  async submitDecision(name, decision) {
    const project = this.manager.status(name);
    const runtime = this.runtimeFor(project);
    const result = runtime.submitDecision(decision);
    this.manager.setExecutionState(
      name,
      result.systemDiagnosis ? 'FAILED' : 'IDLE',
    );
    this.wake('human-decision');
    return { result, project: this.status(name) };
  }

  async reconcileProject(project) {
    if (project.desiredState === 'STOPPED') {
      // A stopped project never schedules planning or delivery. Explicit
      // operator analyses run in an isolated control-only lane instead.
      // Keep the project lifecycle STOPPED and do not derive its status
      // from these independent analysis tasks.
      let runtime = this.runtimes.get(project.id);
      const pendingAnalysis = tasks => tasks.some(task =>
        isAdhocAnalysis(task) && ['READY', 'WORKING', 'RESULT_READY'].includes(task.state)
      );
      let pending = false;
      if (runtime) {
        pending = pendingAnalysis(runtime.store.listTasks(project.id));
      } else if (existsSync(project.stateDb)) {
        // Do not initialize the full runtime for ordinary stopped projects.
        // In particular, keep the stopped SRPG project completely untouched.
        const probe = new SQLiteV2Store(project.stateDb);
        try {
          pending = pendingAnalysis(probe.listTasks(project.id));
        } finally {
          probe.close();
        }
      }
      if (pending) {
        runtime ??= this.runtimeFor(project);
        try {
          await runtime.tick({ adhocOnly: true });
        } catch (error) {
          this.logger?.error?.('Ariad ad-hoc analysis failed for ' + project.id + ': ' +
            (error instanceof Error ? error.stack ?? error.message : String(error)));
        }
      } else if (runtime) {
        runtime.close();
        this.runtimes.delete(project.id);
      }
      return;
    }

    const runtime = this.runtimeFor(project);
    const migrating = runtime.store.getProject(project.id)?.planningModelMigration?.status === 'REBUILDING';
    if (!migrating && ['SUCCEEDED', 'NEEDS_HUMAN'].includes(project.executionState)) return;

    const beforeState = project.executionState;
    try {
      if (project.desiredState === 'RUNNING') {
        if (migrating) {
          const recovered = recoverPrematureMigrationApprovalGate(runtime.store, project.id);
          if (recovered.length) this.logger?.warn?.(
            'Ariad rejected premature migration delivery gate: ' + recovered.map(item => item.taskId).join(', ')
          );
        }
        const activated = activateDeferredIterations({
          store: runtime.store,
          projectId: project.id,
          workspace: project.workspace,
        });
        if (activated.length) this.logger?.warn?.('Ariad activated iteration requests: ' + activated.join(', '));
      }
      await runtime.tick({ schedule: project.desiredState === 'RUNNING' });
      const nextState = this.deriveExecutionState(runtime);
      if (nextState !== beforeState) this.manager.setExecutionState(project.id, nextState);
      if (nextState !== beforeState && ['NEEDS_HUMAN', 'FAILED', 'SUCCEEDED'].includes(nextState)) {
        await this.onProjectEvent?.(this.status(project.id), nextState);
      }
    } catch (error) {
      this.manager.setExecutionState(project.id, 'FAILED');
      this.logger?.error?.(
        `Ariad project ${project.id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
      if (beforeState !== 'FAILED') await this.onProjectEvent?.(this.status(project.id), 'FAILED');
    }
  }

  async reconcile() {
    for (const project of this.manager.list()) {
      await this.reconcileProject(project);
      try {
        await this.memoryCurator?.tick?.(this.manager.status(project.id));
      } catch (error) {
        this.logger?.warn?.(
          `Ariad memory curator scheduling failed for ${project.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
