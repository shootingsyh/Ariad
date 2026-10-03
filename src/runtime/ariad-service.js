import { existsSync } from 'node:fs';

import { ResourcePool } from '../v2/resource-pool.js';
import { ReconcileTrigger } from '../v2/reconcile-trigger.js';
import { SQLiteReconcileSignal } from '../v2/sqlite-reconcile-signal.js';
import { FileReconcileWake } from '../v2/file-reconcile-wake.js';
import { SQLiteV2Store } from '../v2/sqlite-store.js';
import { requireCompleteRoleModels } from './role-models.js';
import { StandaloneProjectRuntime } from './standalone-project-runtime.js';

export class AriadService {
  constructor({
    manager,
    provider,
    logger = null,
    sharedResources = new ResourcePool({ 'local-llm': 1 }),
    reconcileWakePath = null,
    safetyIntervalMs = 10 * 60 * 1000,
    onProjectEvent = null,
  }) {
    if (!manager) throw new Error('AriadService requires manager');
    if (!provider) throw new Error('AriadService requires provider');
    this.manager = manager;
    this.provider = provider;
    this.logger = logger;
    this.sharedResources = sharedResources;
    this.onProjectEvent = onProjectEvent;
    this.runtimes = new Map();
    this.signals = new Map();

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
    await this.provider.close?.();
  }

  runtimeFor(project) {
    let runtime = this.runtimes.get(project.id);
    if (!runtime) {
      runtime = new StandaloneProjectRuntime({
        project,
        provider: this.provider,
        sharedResources: this.sharedResources,
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
    if (runtime) return { ...project, runtime: 'standalone', ...runtime.status() };

    if (project.stateDb && existsSync(project.stateDb)) {
      const store = new SQLiteV2Store(project.stateDb);
      try {
        const tasks = store.listTasks(project.id);
        return {
          ...project,
          runtime: 'standalone',
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
    return { ...project, runtime: 'standalone' };
  }

  async ensureRunning(name) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    const project = this.manager.setDesiredState(name, 'RUNNING');
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
    this.manager.setDesiredState(name, 'PAUSED');
    this.wake('paused');
    return this.status(name);
  }

  async ensureResumed(name) {
    const current = this.manager.status(name);
    requireCompleteRoleModels(current.roleModels ?? {});
    this.manager.setDesiredState(name, 'RUNNING');
    if (current.executionState === 'FAILED') this.manager.setExecutionState(name, 'IDLE');
    this.wake('resumed');
    return this.status(name);
  }

  async ensureStopped(name) {
    const project = this.manager.setDesiredState(name, 'STOPPED');
    const runtime = this.runtimes.get(project.id);
    if (runtime) {
      runtime.close();
      this.runtimes.delete(project.id);
    }
    this.wake('stopped');
    return this.status(name);
  }

  deriveExecutionState(runtime) {
    const status = runtime.status();
    const { tasks } = status;
    if (tasks.needsHuman > 0) return 'NEEDS_HUMAN';
    if (tasks.blocked > 0) return 'FAILED';
    if (tasks.total > 0 && tasks.done === tasks.total) return 'SUCCEEDED';
    if (tasks.working > 0 || tasks.ready > 0 || tasks.resultReady > 0) return 'RUNNING';
    return 'IDLE';
  }

  async reconcile() {
    for (const project of this.manager.list()) {
      if (project.desiredState === 'STOPPED') {
        const runtime = this.runtimes.get(project.id);
        if (runtime) {
          runtime.close();
          this.runtimes.delete(project.id);
        }
        continue;
      }

      if (['SUCCEEDED', 'NEEDS_HUMAN'].includes(project.executionState)) continue;

      const runtime = this.runtimeFor(project);
      const beforeState = project.executionState;
      try {
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
  }
}
