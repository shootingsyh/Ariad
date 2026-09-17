import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteWorkflowStateStore } from '../../../src/sqlite-workflow-state-store.js';
import { TransitionEngine } from '../../../src/transition-engine.js';
import { WorkflowTransitionService } from '../../../src/workflow-transition-service.js';

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeDecision(decision) {
  if (typeof decision !== 'string') throw new Error('decision must be a string');
  const value = decision.trim();
  if (!value) throw new Error('decision must not be empty');
  return value;
}

export class HumanDecisionResumer {
  constructor({ project, now = () => new Date() }) {
    if (!project?.id || !project?.root || !project?.stateDb) throw new Error('project is required');
    this.project = project;
    this.now = now;
    this.projectDir = join(project.root, '.ariad', 'project');
    this.eventsPath = join(this.projectDir, 'project-agent-events.jsonl');
    this.decisionsPath = join(this.projectDir, 'human-decisions.jsonl');
    this.briefPath = join(this.projectDir, 'brief.json');
    this.graphPath = join(project.root, '.ariad', 'task-graph.json');
  }

  pendingRequest() {
    const decisions = new Set(readJsonLines(this.decisionsPath).map((entry) => entry.eventId));
    const requests = readJsonLines(this.eventsPath)
      .filter((entry) => entry?.type === 'NEEDS_HUMAN' && entry?.id && !decisions.has(entry.id));
    return requests.at(-1) ?? null;
  }

  submit(decision) {
    const value = normalizeDecision(decision);
    const request = this.pendingRequest();
    if (!request) throw new Error(`project ${this.project.id} is not waiting for a human decision`);

    const record = {
      version: 1,
      eventId: request.id,
      projectId: this.project.id,
      decidedAt: this.now().toISOString(),
      decision: value,
      request: request.payload ?? {},
    };
    mkdirSync(this.projectDir, { recursive: true });
    appendFileSync(this.decisionsPath, `${JSON.stringify(record)}\n`, 'utf8');

    const brief = readJson(this.briefPath, {
      version: 1,
      projectId: this.project.id,
      goal: this.project.goal ?? null,
      source: 'project-agent',
    });
    const decisions = Array.isArray(brief.decisions) ? brief.decisions : [];
    writeJson(this.briefPath, { ...brief, decisions: [...decisions, record] });

    let resumedTaskId = null;
    if (existsSync(this.graphPath) && existsSync(this.project.stateDb)) {
      const graph = readJson(this.graphPath, { tasks: [] });
      const stateStore = new SQLiteWorkflowStateStore(this.project.stateDb);
      try {
        const service = new WorkflowTransitionService({ store: stateStore, engine: new TransitionEngine() });
        const requestedTaskId = request.payload?.taskId ?? null;
        const candidates = (graph.tasks ?? [])
          .map((task) => task.id)
          .filter((taskId) => stateStore.get(taskId)?.status === 'NEEDS_HUMAN');
        const taskId = requestedTaskId && candidates.includes(requestedTaskId)
          ? requestedTaskId
          : candidates.length === 1
            ? candidates[0]
            : null;
        if (taskId) {
          service.submitHumanDecision(taskId, record);
          resumedTaskId = taskId;
        } else if (candidates.length > 1) {
          throw new Error('multiple workflow tasks need human decisions; request must identify taskId');
        }
      } finally {
        stateStore.close();
      }
    }

    return { record, resumedTaskId };
  }
}
