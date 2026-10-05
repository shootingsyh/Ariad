import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildStandaloneRolePrompt } from './role-run-prompt.js';

const defaultWorkerPath = fileURLToPath(
  new URL('../../runtime/pydantic/worker.py', import.meta.url),
);

function defaultModelConfig(modelRef) {
  const slash = modelRef.indexOf('/');
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new Error(`Invalid Ariad model ref: ${modelRef}`);
  }
  const provider = modelRef.slice(0, slash);
  const model = modelRef.slice(slash + 1);

  if (provider === 'test') {
    return { kind: 'test', model };
  }
  if (provider === 'llamacpp') {
    return {
      kind: 'openai-compatible',
      model,
      baseUrl: process.env.ARIAD_LLAMACPP_BASE_URL || 'http://127.0.0.1:18080/v1',
      apiKeyEnv: 'ARIAD_LLAMACPP_API_KEY',
    };
  }
  throw new Error(
    `No standalone Pydantic model mapping for ${modelRef}; provide resolveModelConfig()`,
  );
}

export class PydanticRuntimeClient {
  constructor({
    python = process.env.ARIAD_PYTHON || process.env.PYTHON || 'python3',
    workerPath = defaultWorkerPath,
    env = process.env,
  } = {}) {
    this.python = python;
    this.workerPath = workerPath;
    this.env = env;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
  }

  static withLoopbackProxyBypass(env) {
    const childEnv = { ...(env ?? {}) };
    const loopback = ['127.0.0.1', 'localhost', '::1'];
    const existing = [childEnv.NO_PROXY, childEnv.no_proxy]
      .filter(Boolean)
      .join(',')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
    for (const host of loopback) {
      if (!existing.includes(host)) existing.push(host);
    }
    childEnv.NO_PROXY = existing.join(',');
    childEnv.no_proxy = existing.join(',');
    return childEnv;
  }

  startWorker() {
    if (this.child) return;
    const child = spawn(this.python, [this.workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: PydanticRuntimeClient.withLoopbackProxyBypass(this.env),
    });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Pydantic runtime request failed'));
    });
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-20000);
    });
    child.on('exit', (code, signal) => {
      const error = new Error(
        `Pydantic runtime exited code=${code ?? 'null'} signal=${signal ?? 'null'}${this.stderr ? `: ${this.stderr}` : ''}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = null;
    });
  }

  async request(method, params = {}) {
    this.startWorker();
    const id = ++this.sequence;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    try {
      await this.request('shutdown');
    } catch {}
    if (this.child === child) {
      child.stdin.end();
      this.child = null;
    }
  }
}

export class PydanticV2Provider {
  constructor(runtime = new PydanticRuntimeClient(), {
    resolveModelRef,
    resolveModelConfig = defaultModelConfig,
  } = {}) {
    this.id = 'pydantic-v2';
    this.runtime = runtime;
    this.resolveModelRef = resolveModelRef;
    this.resolveModelConfig = resolveModelConfig;
  }

  async start(spec) {
    if (!spec?.projectId || !spec?.taskId || !spec?.role) {
      throw new Error('PydanticV2Provider requires projectId, taskId, and role');
    }
    const modelRef = (
      typeof spec.context?.roleModelRef === 'string' && spec.context.roleModelRef.trim()
        ? spec.context.roleModelRef.trim()
        : this.resolveModelRef?.(spec.projectId, spec.role)
    ) ?? null;
    if (!modelRef) {
      throw new Error(
        `No explicit Ariad model configured for role ${spec.role} in project ${spec.projectId}`,
      );
    }
    const modelConfig = await this.resolveModelConfig(modelRef, {
      projectId: spec.projectId,
      taskId: spec.taskId,
      role: spec.role,
    });
    const prompt = buildStandaloneRolePrompt(
      spec.context ?? {},
      spec.prompt ?? '',
    );
    return await this.runtime.request('start', {
      runId: spec.attemptId || `v2:${spec.projectId}:${spec.taskId}`,
      projectId: spec.projectId,
      taskId: spec.taskId,
      role: spec.role,
      workspace: spec.workspace || process.cwd(),
      prompt,
      modelConfig,
      sessionPolicy: spec.sessionPolicy || 'fresh',
      sessionKey: spec.sessionKey || spec.context?.sessionKey || null,
      idleTimeoutSeconds: spec.runtimePolicy?.idleTimeoutSeconds ?? spec.idleTimeoutSeconds ?? 600,
    });
  }

  async poll(handle) {
    return await this.runtime.request('poll', { externalId: handle.externalId });
  }

  async cancel(handle) {
    return await this.runtime.request('cancel', { externalId: handle.externalId });
  }

  async close() {
    await this.runtime.close();
  }
}

export { defaultModelConfig as defaultPydanticModelConfig };
