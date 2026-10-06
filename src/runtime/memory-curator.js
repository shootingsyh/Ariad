import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionHistory } from './session-history.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export class MemoryCurator {
  constructor({ provider, now = () => new Date(), intervalMs = DAY_MS, retryMs = RETRY_MS, logger = null } = {}) {
    if (!provider) throw new Error('MemoryCurator requires provider');
    this.provider = provider;
    this.now = now;
    this.intervalMs = intervalMs;
    this.retryMs = retryMs;
    this.logger = logger;
    this.active = new Map();
  }

  statePath(project) {
    return join(project.workspace, '.ariad', 'memory-curator.json');
  }

  state(project) {
    return readJson(this.statePath(project));
  }

  isDue(project) {
    if (!project?.workspace || !existsSync(project.workspace)) return false;
    if (this.active.has(project.id)) return false;
    const state = this.state(project);
    const now = this.now().getTime();
    const lastSuccess = Date.parse(state.lastSuccessAt ?? '');
    if (Number.isFinite(lastSuccess) && now - lastSuccess < this.intervalMs) return false;
    const lastAttempt = Date.parse(state.lastAttemptAt ?? '');
    if (state.lastFailure && Number.isFinite(lastAttempt) && now - lastAttempt < this.retryMs) return false;
    return true;
  }

  async start(project) {
    if (!this.isDue(project)) return null;
    const now = this.now();
    const prior = this.state(project);
    writeJson(this.statePath(project), {
      ...prior,
      lastAttemptAt: now.toISOString(),
      lastFailure: null,
    });

    const recent = sessionHistory(project.workspace, { sinceHours: 24, limit: 1 });
    if (recent.length === 0) {
      writeJson(this.statePath(project), {
        ...this.state(project),
        lastSuccessAt: this.now().toISOString(),
        lastFailure: null,
        lastSummary: 'No recent session history to curate.',
      });
      return { skipped: true, reason: 'NO_RECENT_HISTORY' };
    }

    const modelRef = project.roleModels?.pm;
    if (!modelRef) throw new Error(`memory curator requires PM model for project ${project.id}`);
    const attemptId = `${project.id}:maintenance:memory-curator:${now.toISOString()}`;
    const handle = await this.provider.start({
      projectId: project.id,
      taskId: 'maintenance:memory-curator',
      role: 'memory_curator',
      attemptId,
      workspace: project.workspace,
      sessionPolicy: 'fresh',
      prompt: [
        'You are the Ariad daily project-memory curator.',
        'Review recent project session history and preserve only concise, reusable engineering knowledge.',
        'First call ariad_session_history with sinceHours=24. Ignore memory_curator sessions and routine chatter.',
        'Good memories include durable decisions, requirements, interface constraints, recurring failure lessons, testing lessons, and important workarounds.',
        'Do NOT copy raw chat, transient progress, ordinary command output, or facts already authoritative in current code/interface artifacts.',
        'Before writing a memory, use ariad_memory_search to avoid an obvious duplicate.',
        'When an interface or code artifact is implicated, use ariad_interface_search or ariad_code_search to identify the best binding.',
        'Write only genuinely useful memories via ariad_memory_write. It is valid to write none.',
        'Keep each memory short and bind it to feature/task/interface/file/symbol when the evidence clearly supports that binding.',
        'Finish with ariad_role_result outcome PASS and summarize what you curated.',
      ].join('\n'),
      context: {
        role: 'memory_curator',
        roleModelRef: modelRef,
        roleModels: project.roleModels ?? {},
      },
    });
    this.active.set(project.id, { handle, attemptId });
    return handle;
  }

  async poll(project) {
    const active = this.active.get(project.id);
    if (!active) return null;
    const result = await this.provider.poll(active.handle);
    if (result.state === 'RUNNING') return result;

    this.active.delete(project.id);
    const state = this.state(project);
    if (result.state === 'COMPLETED' && result.outcome === 'PASS') {
      writeJson(this.statePath(project), {
        ...state,
        lastSuccessAt: this.now().toISOString(),
        lastFailure: null,
        lastSummary: result.summary ?? null,
      });
    } else {
      writeJson(this.statePath(project), {
        ...state,
        lastFailure: result.failure ?? `CURATOR_${result.state}`,
      });
      this.logger?.warn?.(`Ariad memory curator failed for ${project.id}: ${result.failure ?? result.state}`);
    }
    return result;
  }

  async tick(project) {
    const current = await this.poll(project);
    if (current) return current;
    if (this.isDue(project)) {
      const started = await this.start(project);
      if (started?.skipped) return { state: 'SKIPPED', reason: started.reason };
      return { state: 'STARTED' };
    }
    return { state: 'IDLE' };
  }

  async close() {
    for (const { handle } of this.active.values()) {
      try { await this.provider.cancel(handle); } catch {}
    }
    this.active.clear();
  }
}
