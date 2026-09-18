import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
import { validateProjectModel as validateLivingProjectModel } from '../../../src/project-model-validator.js';
import { ProjectAgentNotifier } from './project-agent-notifier.js';

const ROLE_RUNTIME_MAP = Object.freeze({
  developer: 'openclaw',
  tester: 'openclaw',
  reviewer: 'openclaw',
  project_debugger: 'openclaw',
  tech_lead: 'openclaw',
  pm: 'openclaw',
  system_debugger: 'openclaw',
  artist: 'openclaw',
});

const IGNORED_DISCOVERY_NAMES = new Set(['.git', '.ariad', 'node_modules', 'dist', 'build', '.next', 'coverage']);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function validateProjectModel(model, { requireTasks = true } = {}) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Tech Lead returned no projectModel');
  if (!model.currentState || typeof model.currentState !== 'object') throw new Error('projectModel.currentState is required');
  if (!model.architecture || typeof model.architecture !== 'object') throw new Error('projectModel.architecture is required');
  const horizontals = requireArray(model.architecture.horizontals, 'projectModel.architecture.horizontals');
  const verticals = requireArray(model.architecture.verticals, 'projectModel.architecture.verticals');
  if (horizontals.length === 0) throw new Error('Tech Lead plan requires at least one horizontal shared-infrastructure component');
  if (verticals.length === 0) throw new Error('Tech Lead plan requires at least one vertical product-feature component');

  const components = [...horizontals, ...verticals];
  const componentIds = new Set();
  for (const component of components) {
    if (!component?.id || !component?.name || !component?.responsibility) throw new Error('every architecture component requires id, name, and responsibility');
    if (componentIds.has(component.id)) throw new Error(`duplicate architecture component id ${component.id}`);
    componentIds.add(component.id);
  }

  const contracts = requireArray(model.contracts, 'projectModel.contracts');
  if (contracts.length === 0) throw new Error('Tech Lead plan requires explicit cross-component contracts');
  for (const contract of contracts) {
    if (!contract?.id) throw new Error('every contract requires an id');
    if (!componentIds.has(contract.provider)) throw new Error(`contract ${contract.id} has unknown provider ${contract.provider}`);
    if (!Array.isArray(contract.consumers) || contract.consumers.length === 0) throw new Error(`contract ${contract.id} requires consumers`);
    for (const consumer of contract.consumers) {
      if (!componentIds.has(consumer)) throw new Error(`contract ${contract.id} has unknown consumer ${consumer}`);
    }
    if (!contract.purpose || contract.interface == null || !contract.testBoundary) throw new Error(`contract ${contract.id} requires purpose, interface, and testBoundary`);
  }

  if (!model.technicalDirection || typeof model.technicalDirection !== 'object') throw new Error('projectModel.technicalDirection is required');
  if (!model.technicalDirection.summary) throw new Error('technicalDirection.summary is required');
  const languages = requireArray(model.technicalDirection.languages, 'projectModel.technicalDirection.languages');
  if (languages.length === 0) throw new Error('technicalDirection.languages must identify major language choices');
  for (const language of languages) {
    if (!language?.scope || !language?.language || !language?.rationale) throw new Error('every language choice requires scope, language, and rationale');
  }

  if (!model.decomposition || typeof model.decomposition !== 'object') throw new Error('projectModel.decomposition is required');
  const nodes = requireArray(model.decomposition.nodes, 'projectModel.decomposition.nodes');
  if (nodes.length === 0) throw new Error('Tech Lead plan requires recursive decomposition nodes');
  const nodeIds = new Set(nodes.map((node) => node?.id));
  if (nodeIds.size !== nodes.length || nodeIds.has(undefined)) throw new Error('decomposition node ids must be present and unique');
  for (const node of nodes) {
    if (!['component', 'subcomponent', 'task'].includes(node.kind)) throw new Error(`decomposition node ${node.id} has invalid kind`);
    if (!componentIds.has(node.componentId)) throw new Error(`decomposition node ${node.id} has unknown component ${node.componentId}`);
    if (!Array.isArray(node.children)) throw new Error(`decomposition node ${node.id} requires children`);
    for (const child of node.children) if (!nodeIds.has(child)) throw new Error(`decomposition node ${node.id} references unknown child ${child}`);
  }

  const tasks = requireArray(model.tasks ?? [], 'projectModel.tasks');
  if (requireTasks && tasks.length === 0) throw new Error('Tech Lead returned no executable project tasks');
  const taskIds = new Set(tasks.map((task) => task?.id));
  if (taskIds.size !== tasks.length || taskIds.has(undefined)) throw new Error('Tech Lead task ids must be present and unique');
  const decompositionTaskIds = new Set(nodes.filter((node) => node.kind === 'task' && node.children.length === 0).map((node) => node.taskId));
  for (const task of tasks) {
    if (typeof task.componentId !== 'string' || !componentIds.has(task.componentId)) throw new Error(`Tech Lead task ${task.id} has invalid componentId`);
    if (!Array.isArray(task.dependsOn)) throw new Error(`Tech Lead task ${task.id} has invalid dependsOn`);
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) throw new Error(`Tech Lead task ${task.id} has no acceptance criteria`);
    if (typeof task.testStrategy !== 'string' || !task.testStrategy) throw new Error(`Tech Lead task ${task.id} has no test strategy`);
    if (task.atomic !== true) throw new Error(`Tech Lead task ${task.id} must be explicitly atomic`);
    if (!decompositionTaskIds.has(task.id)) throw new Error(`Tech Lead task ${task.id} must be a leaf in decomposition`);
  }
  if (requireTasks) new TaskGraph(tasks);
  return model;
}

function surveyWorkspace(workspace, maxEntries = 250, maxDepth = 5) {
  if (!workspace || !existsSync(workspace)) return [];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxEntries) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DISCOVERY_NAMES.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      found.push({ path: relative(workspace, absolute).replaceAll('\\', '/'), kind: entry.isDirectory() ? 'directory' : 'file' });
      if (entry.isDirectory()) walk(absolute, depth + 1);
      if (found.length >= maxEntries) return;
    }
  };
  walk(workspace, 0);
  return found;
}

function hasExistingProjectContent(workspace) {
  return surveyWorkspace(workspace, 1, 1).length > 0;
}

export class AriadProjectController {
  constructor({ project, runtimeAdapter, projectAgentAdapter = null, finalizeSourceControl = async (_input) => ({ ok: true }), onError = (error) => error }) {
    if (!project?.id || !project?.stateDb || !project?.root) throw new Error('project manifest is required');
    if (!runtimeAdapter) throw new Error('runtimeAdapter is required');
    this.project = project;
    this.runtimeAdapter = runtimeAdapter;
    this.finalizeSourceControl = finalizeSourceControl;
    this.onError = onError;
    this.projectModelDir = join(project.root, '.ariad', 'project');
    this.graphPath = join(project.root, '.ariad', 'task-graph.json');
    this.projectGraphPath = join(this.projectModelDir, 'task-graph.json');
    this.projectAgentNotifier = new ProjectAgentNotifier({ project, adapter: projectAgentAdapter, onError });
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
        try { this.onError(error); } catch {}
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
    return { active: this.active, phase: this.phase, graphPath: this.graphPath, projectModelDir: this.projectModelDir, result: this.result, error: this.error };
  }

  #ensureProjectBrief() {
    mkdirSync(this.projectModelDir, { recursive: true });
    const path = join(this.projectModelDir, 'brief.json');
    if (!existsSync(path)) writeJson(path, { version: 1, projectId: this.project.id, goal: this.project.goal ?? null, source: 'project-agent' });
    return readJson(path);
  }

  #persistProjectModel(model) {
    mkdirSync(this.projectModelDir, { recursive: true });
    writeJson(join(this.projectModelDir, 'current-state.json'), model.currentState);
    writeJson(join(this.projectModelDir, 'architecture.json'), model.architecture);
    writeJson(join(this.projectModelDir, 'contracts.json'), model.contracts);
    writeJson(join(this.projectModelDir, 'dependencies.json'), model.dependencies);
    writeJson(join(this.projectModelDir, 'vertical-slices.json'), model.verticalSlices);
    writeJson(join(this.projectModelDir, 'technical-direction.json'), model.technicalDirection);
    writeJson(join(this.projectModelDir, 'decomposition.json'), model.decomposition);
    writeJson(join(this.projectModelDir, 'project-model.json'), model);
  }

  #readPersistedProjectModel() {
    const fullPath = join(this.projectModelDir, 'project-model.json');
    if (existsSync(fullPath)) return readJson(fullPath);
    const paths = {
      currentState: join(this.projectModelDir, 'current-state.json'), architecture: join(this.projectModelDir, 'architecture.json'),
      contracts: join(this.projectModelDir, 'contracts.json'), dependencies: join(this.projectModelDir, 'dependencies.json'), verticalSlices: join(this.projectModelDir, 'vertical-slices.json'), technicalDirection: join(this.projectModelDir, 'technical-direction.json'),
      decomposition: join(this.projectModelDir, 'decomposition.json'),
    };
    if (!Object.values(paths).every(existsSync)) return null;
    return { currentState: readJson(paths.currentState), architecture: readJson(paths.architecture), contracts: readJson(paths.contracts), dependencies: readJson(paths.dependencies), verticalSlices: readJson(paths.verticalSlices), technicalDirection: readJson(paths.technicalDirection), decomposition: readJson(paths.decomposition), tasks: existsSync(this.projectGraphPath) ? readJson(this.projectGraphPath).tasks : [] };
  }

  async #notifyNeedsHuman(sourceRole, phase, result, projectModel = null) {
    await this.projectAgentNotifier.notify('NEEDS_HUMAN', {
      sourceRole,
      phase,
      reason: result?.result?.reason ?? result?.reason ?? null,
      questions: result?.result?.questions ?? [],
      currentState: projectModel?.currentState ?? null,
    });
  }

  async #runTechLead(runtimeExecutor, context, { requireTasks }) {
    const result = await runtimeExecutor.run('tech_lead', { ...context, workspace: this.project.workspace });
    if (result.executionStatus !== 'COMPLETED') throw new Error(`Tech Lead failed: ${result.failure ?? 'unknown failure'}`);
    if (result.outcome === 'NEEDS_HUMAN') return { needsHuman: true, result };
    if (!['PLANNED', 'REPLANNED'].includes(result.outcome)) throw new Error(`Tech Lead returned unexpected outcome: ${result.outcome}`);
    validateProjectModel(result.result?.projectModel, { requireTasks });
    const model = validateLivingProjectModel(result.result?.projectModel, { requireTasks });
    this.#persistProjectModel(model);
    return { needsHuman: false, model, result };
  }

  async #runPmReview(runtimeExecutor, context, filename, allowed = ['PLAN_ACCEPTED', 'PLAN_REVISION_REQUIRED', 'NEEDS_HUMAN']) {
    const review = await runtimeExecutor.run('pm', context);
    if (review.executionStatus !== 'COMPLETED') throw new Error(`PM product review failed: ${review.failure ?? 'unknown failure'}`);
    if (!allowed.includes(review.outcome)) throw new Error(`PM product review returned unexpected outcome: ${review.outcome}`);
    writeJson(join(this.projectModelDir, filename), { outcome: review.outcome, ...(review.result ?? {}) });
    return review;
  }

  async #ensureExistingProjectDiscovery(runtimeExecutor, brief) {
    const workspaceSurvey = surveyWorkspace(this.project.workspace);
    writeJson(join(this.projectModelDir, 'workspace-survey.json'), workspaceSurvey);
    if (!hasExistingProjectContent(this.project.workspace)) return { status: 'READY', model: null };
    const persisted = this.#readPersistedProjectModel();
    const currentStateReviewPath = join(this.projectModelDir, 'current-state-review.json');
    if (persisted && existsSync(currentStateReviewPath) && ['CURRENT_STATE_ACKNOWLEDGED', 'PLAN_ACCEPTED'].includes(readJson(currentStateReviewPath).outcome)) return { status: 'READY', model: persisted };

    this.phase = 'DISCOVERING';
    let guidance = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const discovery = await this.#runTechLead(runtimeExecutor, {
        taskId: '__project_discovery__', projectId: this.project.id, planningPhase: 'EXISTING_PROJECT_DISCOVERY', projectBrief: brief, workspaceSurvey, productReviewGuidance: guidance,
      }, { requireTasks: false });
      if (discovery.needsHuman) {
        await this.#notifyNeedsHuman('tech_lead', 'EXISTING_PROJECT_DISCOVERY', discovery.result);
        return { status: 'NEEDS_HUMAN', model: null };
      }

      this.phase = 'PRODUCT_REVIEW';
      const review = await this.#runPmReview(runtimeExecutor, {
        taskId: '__project_current_state_review__', projectId: this.project.id, productPhase: 'CURRENT_STATE_REVIEW', projectBrief: brief, currentProjectModel: discovery.model,
      }, 'current-state-review.json', ['CURRENT_STATE_ACKNOWLEDGED', 'PLAN_REVISION_REQUIRED', 'NEEDS_HUMAN']);
      if (review.outcome === 'CURRENT_STATE_ACKNOWLEDGED') {
        await this.projectAgentNotifier.notify('CURRENT_STATE_READY', {
          currentState: discovery.model.currentState,
          customerOutcomeSummary: review.result?.customerOutcomeSummary ?? null,
          reason: review.result?.reason ?? null,
        });
        return { status: 'READY', model: discovery.model };
      }
      if (review.outcome === 'NEEDS_HUMAN') {
        await this.#notifyNeedsHuman('pm', 'CURRENT_STATE_REVIEW', review, discovery.model);
        return { status: 'NEEDS_HUMAN', model: discovery.model };
      }
      guidance = review.result?.guidance ?? review.result?.reason ?? 'PM requested a more accurate current-state reconstruction.';
    }
    throw new Error('Tech Lead current-state discovery did not satisfy PM review after 3 revisions');
  }

  async #ensureTaskGraph(runtimeExecutor) {
    if (existsSync(this.graphPath)) {
      const tasks = readJson(this.graphPath).tasks;
      new TaskGraph(tasks);
      return { status: 'READY', tasks, projectModel: this.#readPersistedProjectModel() };
    }
    if (!this.project.goal) throw new Error('project goal is required before Ariad can plan work');

    const brief = this.#ensureProjectBrief();
    const discovery = await this.#ensureExistingProjectDiscovery(runtimeExecutor, brief);
    if (discovery.status === 'NEEDS_HUMAN') return { status: 'NEEDS_HUMAN', tasks: null, projectModel: discovery.model };

    this.phase = 'PLANNING';
    let guidance = null;
    let baseModel = discovery.model;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const planned = await this.#runTechLead(runtimeExecutor, {
        taskId: '__project_plan__', projectId: this.project.id, planningPhase: 'REQUIREMENT_PLAN', projectBrief: brief, currentProjectModel: baseModel, productReviewGuidance: guidance,
      }, { requireTasks: true });
      if (planned.needsHuman) {
        await this.#notifyNeedsHuman('tech_lead', 'REQUIREMENT_PLAN', planned.result, baseModel);
        return { status: 'NEEDS_HUMAN', tasks: null, projectModel: baseModel };
      }

      this.phase = 'PRODUCT_REVIEW';
      const review = await this.#runPmReview(runtimeExecutor, {
        taskId: '__project_plan_review__', projectId: this.project.id, productPhase: 'PLAN_REVIEW', projectBrief: brief, currentProjectModel: planned.model,
      }, 'plan-review.json');
      if (review.outcome === 'NEEDS_HUMAN') {
        await this.#notifyNeedsHuman('pm', 'PLAN_REVIEW', review, planned.model);
        return { status: 'NEEDS_HUMAN', tasks: null, projectModel: planned.model };
      }
      if (review.outcome === 'PLAN_REVISION_REQUIRED') {
        guidance = review.result?.guidance ?? review.result?.reason ?? 'PM requested product-plan revision.';
        baseModel = planned.model;
        continue;
      }

      const tasks = planned.model.tasks;
      new TaskGraph(tasks);
      const graphDocument = { version: 2, approvedBy: 'pm', tasks };
      writeJson(this.projectGraphPath, graphDocument);
      writeJson(this.graphPath, graphDocument);
      return { status: 'READY', tasks, projectModel: planned.model };
    }
    throw new Error('Tech Lead plan did not satisfy PM product review after 3 revisions');
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
      const runtimeExecutor = new RuntimeExecutor({ registry, runStore, roleRuntimeMap: ROLE_RUNTIME_MAP, maxDurationMs: 10 * 60_000 });
      const planning = await this.#ensureTaskGraph(runtimeExecutor);
      if (planning.status === 'NEEDS_HUMAN') return { status: 'NEEDS_HUMAN' };
      const { tasks, projectModel } = planning;
      const graph = new TaskGraph(tasks);

      for (const task of graph.list()) {
        if (!stateStore.get(task.id)) stateStore.create(task.id, { context: {
          projectId: this.project.id, projectGoal: this.project.goal ?? null, task,
          architecture: projectModel?.architecture ?? null, contracts: projectModel?.contracts ?? [], dependencies: projectModel?.dependencies ?? [], verticalSlices: projectModel?.verticalSlices ?? [], technicalDirection: projectModel?.technicalDirection ?? null,
        } });
      }

      const transitionService = new WorkflowTransitionService({ store: stateStore, engine: new TransitionEngine() });
      const effectExecutor = new EffectExecutor({ transitionService, finalizeSourceControl: this.finalizeSourceControl });
      const scheduler = new Scheduler({
        resourceManager: { tryAcquire() { return null; } },
        isRuntimeHealthy: () => true,
        dispatch: (work) => runtimeExecutor.run(work.role, { ...work.context, workspace: this.project.workspace }),
      });
      const coordinator = new Coordinator({ scheduler, applyExecutionResult: (work, result) => transitionService.apply(work, result), effectExecutor });
      const workBuilder = new WorkBuilder({ graph, stateStore, roleRuntimeMap: ROLE_RUNTIME_MAP });
      const runner = new GraphRunner({ graph, workBuilder, coordinator, stateStore, maxTicks: 200 });

      this.phase = 'RUNNING';
      const result = await runner.run();
      if (result.status === 'STOPPED') {
        const needsHuman = Object.entries(result.states ?? {}).find(([, state]) => state?.status === 'NEEDS_HUMAN');
        if (needsHuman) {
          const [taskId, state] = needsHuman;
          await this.projectAgentNotifier.notify('NEEDS_HUMAN', {
            sourceRole: state.stage ?? null,
            phase: 'TASK_WORKFLOW',
            taskId,
            reason: state.context?.lastDiagnosis ?? state.context?.reason ?? null,
            questions: state.context?.questions ?? [],
            currentState: projectModel?.currentState ?? null,
          });
        }
      }
      return result;
    } finally {
      stateStore.close();
      runStore.close();
    }
  }
}
