import { OpenClawRuntimeAdapter } from './openclaw-runtime-adapter.js';

type V2ExecutionSpec = {
  projectId: string;
  taskId: string;
  role: string;
  prompt?: string;
  context?: Record<string, unknown>;
  workspace?: string;
  [key: string]: unknown;
};

export class OpenClawV2Provider {
  readonly id = 'openclaw-v2';
  private readonly runtime: OpenClawRuntimeAdapter;

  constructor(runtime: OpenClawRuntimeAdapter) {
    this.runtime = runtime;
  }

  async start(spec: V2ExecutionSpec) {
    if (!spec?.projectId || !spec?.taskId || !spec?.role) {
      throw new Error('OpenClawV2Provider requires projectId, taskId, and role');
    }

    const runId = typeof spec.attemptId === 'string' && spec.attemptId
      ? spec.attemptId
      : ['v2', spec.projectId, spec.taskId].join(':');

    const context = {
      ...(spec.context ?? {}),
      projectId: spec.projectId,
      taskId: spec.taskId,
      ...(spec.prompt ? { prompt: spec.prompt } : {}),
      ...(typeof spec.context?.v2Prompt === 'string' ? { v2Prompt: spec.context.v2Prompt } : {}),
      ...(spec.workspace ? { workspace: spec.workspace } : {}),
      ...(spec.sessionPolicy ? { sessionPolicy: spec.sessionPolicy } : {}),
      ...(spec.idempotencyKey ? { idempotencyKey: spec.idempotencyKey } : {}),
      ...(spec.attemptId ? { attemptId: spec.attemptId } : {}),
    };

    const handle = await this.runtime.start({
      runId,
      role: spec.role,
      context,
    });

    return {
      externalId: handle.externalId,
      runtimeId: handle.runtimeId,
    };
  }

  async poll(handle: { externalId: string }) {
    const status = await this.runtime.poll(handle);
    if (status.state !== 'COMPLETED') return status;

    const completed = status as {
      state: 'COMPLETED';
      outcome?: unknown;
      result?: unknown;
    };
    const result = completed.result as Record<string, unknown> | null | undefined;
    return {
      state: 'COMPLETED',
      outcome: typeof completed.outcome === 'string' ? completed.outcome : 'PASS',
      summary: typeof result?.summary === 'string' ? result.summary : '',
      keyPoints: Array.isArray(result?.keyPoints) ? result.keyPoints : [],
      artifacts: Array.isArray(result?.artifacts) ? result.artifacts : [],
      result: result ?? null,
    };
  }

  async cancel(handle: { externalId: string }) {
    return this.runtime.cancel(handle);
  }
}
