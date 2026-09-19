import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

function decodeJson(value: unknown) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

const TERMINAL_EXECUTION_STATES = new Set(['SUCCEEDED', 'FAILED', 'NEEDS_HUMAN']);

function executionStateForController(status: { phase?: string } | undefined) {
  switch (status?.phase) {
    case 'STARTING':
    case 'DISCOVERING':
    case 'PRODUCT_REVIEW':
    case 'PLANNING':
      return 'PLANNING';
    case 'RUNNING':
      return 'RUNNING';
    case 'NEEDS_HUMAN':
      return 'NEEDS_HUMAN';
    case 'FAILED':
      return 'FAILED';
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'STOPPED':
      return 'IDLE';
    default:
      return null;
  }
}

function readLastRun(stateDb: string | undefined) {
  if (!stateDb || !existsSync(stateDb)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDb, { readOnly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
    if (!table) return null;
    const row = db.prepare(`
      SELECT id, task_id, role, attempt, state, external_id, failure_json, created_at, updated_at
      FROM runs
      ORDER BY seq DESC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      role: row.role,
      attempt: row.attempt,
      state: row.state,
      externalId: row.external_id,
      failure: decodeJson(row.failure_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

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
    const current = this.controllers.get(project.id);
    const snapshot = current?.status?.() as { active?: boolean; phase?: string } | undefined;

    if (current && snapshot?.active !== false) return this.status(project.id);

    if (current) {
      await current.stop();
      this.controllers.delete(project.id);
    }

    if (project.executionState === 'SUCCEEDED' || project.executionState === 'NEEDS_HUMAN') {
      return this.status(project.id);
    }

    if (project.executionState !== 'IDLE') {
      this.manager.setExecutionState(project.id, 'IDLE');
    }
    return this.status(project.id);
  }

  async ensureStopped(name: string) {
    const project = this.manager.setDesiredState(name, 'STOPPED');
    return this.status(project.id);
  }

  async submitDecision(name: string, decision: string) {
    const project = this.manager.setDesiredState(name, 'RUNNING');
    const current = this.controllers.get(project.id);
    const snapshot = current?.status?.() as { active?: boolean } | undefined;
    if (snapshot?.active) throw new Error(`project ${project.id} is still running and cannot accept a human decision yet`);

    const resumer = new HumanDecisionResumer({ project });
    if (!resumer.pendingRequest()) throw new Error(`project ${project.id} is not waiting for a human decision`);
    const resumed = resumer.submit(decision);

    if (current) {
      await current.stop();
      this.controllers.delete(project.id);
    }
    this.manager.setExecutionState(project.id, 'IDLE');
    return { resumed, project: this.status(project.id) };
  }

  async reconcile() {
    if (!this.started) return;
    if (this.reconcilePromise) return this.reconcilePromise;

    this.reconcilePromise = (async () => {
      for (const listedProject of this.manager.list()) {
        let project = listedProject;
        let controller = this.controllers.get(project.id);
        let snapshot = controller?.status?.() as { active?: boolean; phase?: string } | undefined;
        const observedExecutionState = executionStateForController(snapshot);
        if (observedExecutionState) {
          project = this.manager.setExecutionState(project.id, observedExecutionState);
        }

        if (controller && snapshot?.active === false) {
          this.controllers.delete(project.id);
          controller = undefined;
          snapshot = undefined;
        }

        if (project.desiredState === 'STOPPED') {
          if (controller) {
            await controller.stop();
            const stoppedSnapshot = controller.status?.() as { phase?: string } | undefined;
            const stoppedExecutionState = executionStateForController(stoppedSnapshot);
            if (stoppedExecutionState && TERMINAL_EXECUTION_STATES.has(stoppedExecutionState)) {
              project = this.manager.setExecutionState(project.id, stoppedExecutionState);
            } else if (!TERMINAL_EXECUTION_STATES.has(project.executionState)) {
              project = this.manager.setExecutionState(project.id, 'IDLE');
            }
            this.controllers.delete(project.id);
          } else if (!TERMINAL_EXECUTION_STATES.has(project.executionState) && project.executionState !== 'IDLE') {
            project = this.manager.setExecutionState(project.id, 'IDLE');
          }
          continue;
        }

        if (
          project.desiredState === 'RUNNING'
          && !controller
          && !TERMINAL_EXECUTION_STATES.has(project.executionState)
        ) {
          const nextProject = this.manager.setExecutionState(project.id, 'PLANNING');
          const next = this.createController(nextProject);
          this.controllers.set(project.id, next);
          await next.start();
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
    const controllerStatus = controller?.status?.() as { active?: boolean; phase?: string; error?: string | null } | undefined;
    const observedExecutionState = executionStateForController(controllerStatus);
    const effectiveProject = observedExecutionState
      ? this.manager.setExecutionState(project.id, observedExecutionState)
      : project;
    const lastRun = readLastRun(project.stateDb);
    const failure = controllerStatus?.phase === 'FAILED'
      ? { source: 'controller', message: controllerStatus.error ?? 'PROJECT_FAILED' }
      : lastRun?.state === 'FAILED'
        ? { source: 'run', runId: lastRun.id, role: lastRun.role, failure: lastRun.failure }
        : null;
    return {
      ...effectiveProject,
      active: Boolean(controller && controllerStatus?.active !== false),
      controller: controllerStatus ?? null,
      lastRun,
      failure,
      supervisorStarted: this.started,
    };
  }

  list() {
    return this.manager.list().map((project) => this.status(project.id));
  }
}
