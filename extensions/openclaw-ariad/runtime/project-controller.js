import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskGraph } from '../../../src/task-graph.js';
import { WorkBuilder } from '../../../src/work-builder.js';
import { GraphRunner } from '../../../src/graph-runner.js';
import { Coordinator } from '../../../src/coordinator.js';
import { Scheduler } from '../../../src/scheduler.js';
import { RuntimeRegistry } from '../../../src/runtime-registry.js';
import { RuntimeExecutor } from '../../../src/runtime-executor.js';
import { SQLiteRunStore } from '../../../src/sqlite-run-store.js';
import { SQLiteWorkflowStateStore } from '../../../src/sqlite-workflow-state-store.js';
import { TransitionEngine } from '../../../src/transition-engine.js';
import { WorkflowTransitionService } from '../../../src/workflow-transition-service.js';
import { EffectExecutor } from '../../../src/effect-executor.js';

const ROLE_RUNTIME_MAP = Object.freeze({
  developer: 'openclaw',
  tester: 'openclaw',
  reviewer: 'openclaw',
  project_debugger: 'openclaw',
  pm: 'openclaw',
  system_debugger: 'openclaw',
  artist: 'openclaw',
});

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validatePlannedTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('PM returned no project tasks');
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id) {
      throw new Error('PM returned a task without a stable id');
    }
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      throw new Error(`PM task ${task.id} has no acceptance criteria`);
    }
  }
  return tasks;
}

export class AriadProjectController {
  constructor({ project, runtimeAdapter, finalizeSourceControl = async () => ({ ok: true }), onError = null }) {
    if (!project?.id || !project?.stateDb || !project?.root) throw new Error('project manifest is required');
    if (!runtimeAdapter) throw new Error('runtimeAdapter is required');
    this.project = project;
    this.runtimeAdapter = runtimeAdapter;
    this.finalizeSourceControl = finalizeSourceControl;
    this.onError = typeof onError === 'function' ? onError : null;
    this.graphPath = join(project.root, '.ariad', 'task-graph.json');
    this.active = false;
    this.phase = 'STOPPED';
    this.result = null;
    this.error = null;
    this.runPromise = null;
  }

  async start() {
    if (this.runPromise) return;
    this.active = true;
    this.phase = 'STARTING';
    this.error = null;
    this.runPromise = this.#run()
      .then((result) => {
        this.result = result;
        this.phase = result.status;
        return result;
      })
      .catch((error) => {
        this.error = error instanceof Error ? error.message : String(error);
        this.phase = 'FAILED';
        try { this.onError?.(error); } catch {}
        throw error;
      })
      .finally(() => {
        this.active = false;
      });
    this.runPromise.catch(() => {});
  }

  async stop() {
    this.active = false;
    if (this.runPromise) {
      try { await this.runPromise; } catch {}
    }
    if (this.phase === 'STARTING' || this.phase === 'RUNNING') this.phase = 'STOPPED';
  }

  status() {
    return {
      active: this.active,
      phase: this.phase,
      graphPath: this.graphPath,
      result: this.result,
      error: this.error,
    };
  }

  async #ensureTaskGraph(runtimeExecutor) {
    if (existsSync(this.graphPath)) return validatePlannedTasks(readJson(this.graphPath).tasks);
    if (!this.project.goal) throw new Error('project goal is required before Ariad can plan work');

    this.phase = 'PLANNING';
    const plan = await runtimeExecutor.run('pm', {
      taskId: '__project_plan__',
      projectId: this.project.id,
      projectGoal: this.project.goal,
      planningPhase: 'INITIAL_PLAN',
    });
    if (plan.executionStatus !== 'COMPLETED') throw new Error(`PM planning failed: ${plan.failure ?? 'unknown failure'}`);
    if (plan.outcome !== 'REPLANNED') throw new Error(`PM planning returned unexpected outcome: ${plan.outcome}`);
    const tasks = validatePlannedTasks(plan.result?.tasks);
    new TaskGraph(tasks);
    writeJson(this.graphPath, { version: 1, tasks });
    return tasks;
  }

  async #run() {
    await this.runtimeAdapter.install();
    const health = await this.runtimeAdapter.probe();
    if (health?.health !== 'HEALTHY') throw new Error('OpenClaw runtime is not healthy');

    const registry = new RuntimeRegistry();
    registry.register('openclaw', this.runtimeAdapter);
    const runStore = new SQLiteRunStore(this.project.stateDb);
    const stateStore = new SQLiteWorkflowStateStore(this.project.stateDb);

    try {
      const runtimeExecutor = new RuntimeExecutor({
        registry,
        runStore,
        roleRuntimeMap: ROLE_RUNTIME_MAP,
        maxPolls: 400,
      });
      const tasks = await this.#ensureTaskGraph(runtimeExecutor);
      const graph = new TaskGraph(tasks);

      for (const task of graph.list()) {
        if (!stateStore.get(task.id)) {
          stateStore.create(task.id, {
            context: {
              projectId: this.project.id,
              projectGoal: this.project.goal ?? null,
              task,
            },
          });
        }
      }

      const transitionService = new WorkflowTransitionService({
        store: stateStore,
        engine: new TransitionEngine(),
      });
      const effectExecutor = new EffectExecutor({
        transitionService,
        finalizeSourceControl: this.finalizeSourceControl,
      });
      const scheduler = new Scheduler({
        resourceManager: { tryAcquire() { return null; } },
        isRuntimeHealthy: () => true,
        dispatch: (work) => runtimeExecutor.run(work.role, work.context),
      });
      const coordinator = new Coordinator({
        scheduler,
        applyExecutionResult: (work, result) => transitionService.apply(work, result),
        effectExecutor,
      });
      const workBuilder = new WorkBuilder({
        graph,
        stateStore,
        roleRuntimeMap: ROLE_RUNTIME_MAP,
      });
      const runner = new GraphRunner({ graph, workBuilder, coordinator, stateStore, maxTicks: 200 });

      this.phase = 'RUNNING';
      return await runner.run();
    } finally {
      stateStore.close();
      runStore.close();
    }
  }
}
