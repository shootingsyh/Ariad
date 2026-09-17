import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateProjectAgentAdapter } from '../../../src/project-agent-adapter.js';

export class ProjectAgentNotifier {
  constructor({ project, adapter = null, onError = () => {}, now = () => new Date() }) {
    if (!project?.id || !project?.root) throw new Error('project is required');
    this.project = project;
    this.adapter = adapter ? validateProjectAgentAdapter(adapter) : null;
    this.onError = onError;
    this.now = now;
    this.sequence = 0;
    this.dir = join(project.root, '.ariad', 'project');
    this.path = join(this.dir, 'project-agent-events.jsonl');
  }

  async notify(type, payload = {}) {
    const createdAt = this.now();
    const event = {
      version: 1,
      id: `${this.project.id}:${createdAt.getTime()}:${++this.sequence}`,
      projectId: this.project.id,
      type,
      createdAt: createdAt.toISOString(),
      payload,
    };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ ...event, delivery: 'PENDING' })}\n`, 'utf8');

    if (!this.adapter || !this.project.projectAgent?.sessionKey) return { event, delivery: 'UNBOUND' };
    try {
      await this.adapter.notify({ binding: this.project.projectAgent, event });
      appendFileSync(this.path, `${JSON.stringify({ eventId: event.id, delivery: 'DELIVERED', deliveredAt: this.now().toISOString() })}\n`, 'utf8');
      return { event, delivery: 'DELIVERED' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFileSync(this.path, `${JSON.stringify({ eventId: event.id, delivery: 'FAILED', error: message, failedAt: this.now().toISOString() })}\n`, 'utf8');
      try { this.onError(error); } catch {}
      return { event, delivery: 'FAILED', error: message };
    }
  }
}
