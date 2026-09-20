import { homedir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { PromptRenderer } from '../../../src/llm/prompt-renderer.js';
import { SQLiteV2Store } from '../../../src/v2/sqlite-store.js';
import { RoleRegistry } from '../../../src/v2/role-registry.js';
import { ProviderRegistry } from '../../../src/v2/provider-registry.js';
import { ResourcePool } from '../../../src/v2/resource-pool.js';
import { V2Scheduler } from '../../../src/v2/scheduler.js';
import { V2Supervisor } from '../../../src/v2/supervisor.js';
import { AriadProjectManager, defaultProjectsRoot } from '../runtime/project-manager.js';
import { contract } from './contract.js';
import { OpenClawProjectAgentAdapter } from './openclaw-project-agent-adapter.js';
import { OpenClawRuntimeAdapter } from './openclaw-runtime-adapter.js';
import { OpenClawV2Provider } from './openclaw-v2-provider.js';
import { AriadV2Service } from './ariad-v2-service.js';
import { AriadDashboardService } from './dashboard-service.js';

const promptRenderer = new PromptRenderer();

function renderRoleMessage(role: string, context: Record<string, unknown>) {
  if (typeof context.v2Prompt === 'string' && context.v2Prompt.trim()) {
    const { v2Prompt, ...runtimeContext } = context;
    return [
      v2Prompt,
      '',
      'ARIAD RUNTIME CONTEXT',
      JSON.stringify(runtimeContext),
    ].join('\n');
  }
  const rendered = promptRenderer.render(role, context);
  return rendered.messages
    .map((message: { role: string; content: string }) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join('\n\n');
}

export default defineFeaturePlugin({
  contract,
  name: 'Ariad',
  description: 'Create and manage isolated Ariad autonomous engineering projects.',
  setup(api) {
    const projectsRoot = process.env.ARIAD_PROJECTS_ROOT || defaultProjectsRoot(homedir());
    const pushSourceControl = process.env.ARIAD_SOURCE_CONTROL_PUSH !== '0';
    const manager = new AriadProjectManager({ projectsRoot });
    const runtimeAdapter = new OpenClawRuntimeAdapter({
      subagent: api.runtime.subagent,
      agentId: process.env.ARIAD_OPENCLAW_AGENT_ID || 'main',
      renderMessage: renderRoleMessage,
      cancelRun: async (runId) => {
        const runs = (api.runtime.tasks as any)?.runs;
        if (typeof runs?.cancel === 'function') await runs.cancel(runId);
      },
    });
    const projectAgentAdapter = new OpenClawProjectAgentAdapter({ gateway: api.runtime.gateway });
    const v2Provider = new OpenClawV2Provider(runtimeAdapter);
    const dashboard = new AriadDashboardService({
      manager,
      host: process.env.ARIAD_DASHBOARD_HOST || '127.0.0.1',
      port: Number(process.env.ARIAD_DASHBOARD_PORT || 18791),
      logger: api.logger,
    });

    const v2Service = new AriadV2Service({
      manager,
      provider: v2Provider,
      pushSourceControl,
      logger: api.logger,
      onProjectEvent: async (project, type) => {
        if (!project.frontdeskBinding) return;
        try {
          await projectAgentAdapter.notify({
            binding: project.frontdeskBinding,
            event: {
              version: 1,
              id: `frontdesk:${project.id}:${type}:${Date.now()}`,
              projectId: project.id,
              type,
              createdAt: new Date().toISOString(),
              payload: {
                executionState: project.executionState,
                desiredState: project.desiredState,
              },
            },
          });
        } catch (error) {
          api.logger?.warn?.(
            `Ariad Frontdesk notification for ${project.id} failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    });

    api.registerService({
      id: 'ariad-v2-service',
      async start() { await v2Service.start(); },
      async stop() { await v2Service.stop(); },
    });

    api.registerService({
      id: 'ariad-dashboard-service',
      async start() {
        try {
          await dashboard.start();
        } catch (error) {
          api.logger?.warn?.(
            `Ariad dashboard unavailable: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
      async stop() {
        try {
          await dashboard.stop();
        } catch (error) {
          api.logger?.warn?.(
            `Ariad dashboard stop failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    });

    if (process.env.ARIAD_CI_RUNTIME_PROBE === '1') {
      api.registerGatewayMethod('ariad.ci.roleRun', async ({ params, respond }) => {
        try {
          const input = (params ?? {}) as { role?: string; context?: Record<string, unknown> };
          if (!input.role) throw new Error('role is required');
          const runId = `ci-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const handle = await runtimeAdapter.start({ runId, role: input.role, context: input.context ?? {} });
          let result: any = { state: 'RUNNING' };
          for (let i = 0; i < 200 && result.state === 'RUNNING'; i += 1) {
            result = await runtimeAdapter.poll(handle);
          }
          respond(true, { handle, result });
        } catch (error) {
          respond(false, undefined, { code: 'UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
        }
      }, { scope: 'operator.admin' });

      api.registerGatewayMethod('ariad.ci.v2Task', async ({ respond }) => {
        const ciRoot = join(projectsRoot, '__v2-gateway-e2e__');
        const workspace = join(ciRoot, 'workspace');
        const dbPath = join(ciRoot, 'state.db');
        try {
          rmSync(ciRoot, { recursive: true, force: true });
          mkdirSync(workspace, { recursive: true });
          writeFileSync(join(workspace, 'health.txt'), 'status=healthy\ncycle=2\n');

          const store = new SQLiteV2Store(dbPath);
          try {
            store.createProject({ id: 'v2-e2e', spec: 'Verify OpenClaw v2 provider integration.' });
            store.createTask({
              id: 'T1',
              projectId: 'v2-e2e',
              stage: 'reviewer',
              input: { acceptanceCriteria: ['health.txt reports status=healthy'] },
            });

            const roles = new RoleRegistry();
            roles.register('reviewer', {
              prepare: ({ task }: any) => ({
                provider: 'openclaw-v2',
                workspace,
                context: {
                  acceptanceCriteria: task.input?.acceptanceCriteria ?? [],
                  devCycle: 2,
                },
              }),
              transition: ({ result }: any) => result.outcome === 'PASS'
                ? { stage: 'reviewer', state: 'DONE' }
                : { stage: 'reviewer', state: 'READY' },
            });

            const providers = new ProviderRegistry();
            providers.register(v2Provider);
            const resources = new ResourcePool({});
            const scheduler = new V2Scheduler({ store, roles, providers, resources });
            const v2Supervisor = new V2Supervisor({ store, providers, resources });

            const first = await scheduler.tick('v2-e2e');
            let task = store.getTask('T1');
            for (let i = 0; i < 40 && task?.state === 'WORKING'; i += 1) {
              await v2Supervisor.audit('v2-e2e');
              task = store.getTask('T1');
            }
            if (task?.state === 'RESULT_READY') {
              await scheduler.tick('v2-e2e');
              task = store.getTask('T1');
            }

            respond(true, {
              started: first.started,
              task: task ? {
                id: task.id,
                state: task.state,
                stage: task.stage,
                history: task.history,
              } : null,
            });
          } finally {
            store.close();
          }
        } catch (error) {
          respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }, { scope: 'operator.admin' });

      api.registerGatewayMethod('ariad.ci.project', async ({ params, respond }) => {
        try {
          const input = (params ?? {}) as { action?: string; name?: string; goal?: string; mode?: 'NEW' | 'TAKEOVER'; sourcePath?: string };
          if (!input.action) throw new Error('action is required');
          if (input.action === 'create') {
            if (!input.name) throw new Error('name is required');
            const project = manager.create(input.name, {
              goal: input.goal ?? null,
              mode: input.mode ?? null,
              sourcePath: input.sourcePath ?? null,
              projectAgent: null,
            });
            respond(true, { project: v2Service.status(project.id) });
            return;
          }
          if (!input.name) throw new Error('name is required');
          if (input.action === 'start') {
            respond(true, { project: await v2Service.ensureRunning(input.name) });
            return;
          }
          if (input.action === 'status') {
            respond(true, { project: v2Service.status(input.name) });
            return;
          }
          if (input.action === 'adopt') {
            if (!input.sourcePath) throw new Error('sourcePath is required for adopt');
            respond(true, { project: manager.adopt(input.name, input.sourcePath) });
            return;
          }
          throw new Error(`unsupported CI project action: ${input.action}`);
        } catch (error) {
          respond(false, undefined, { code: 'UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
        }
      }, { scope: 'operator.admin' });
    }

    return {
      async project(input, invocation) {
        const { action, name, goal, mode, sourcePath, decision, agentId, sessionKey } = input;
        let details: unknown;
        if (action === 'list') {
          details = { action, projects: v2Service.list() };
        } else {
          if (!name) throw new Error(`name is required for action ${action}`);
          if (action === 'create') {
            const toolContext = invocation.source === 'tool' ? invocation.tool as any : null;
            const project = manager.create(name, {
              goal: goal ?? null,
              mode: mode ?? null,
              sourcePath: sourcePath ?? null,
              frontdeskBinding: {
                host: 'openclaw',
                agentId: toolContext?.agentId ?? null,
                sessionKey: toolContext?.sessionKey ?? toolContext?.session?.key ?? null,
              },
            });
            details = { action, project: v2Service.status(project.id) };
          } else if (action === 'status') {
            details = { action, project: v2Service.status(name) };
          } else if (action === 'adopt') {
            if (!sourcePath) throw new Error('sourcePath is required for action adopt');
            details = { action, project: manager.adopt(name, sourcePath) };
          } else if (action === 'start') {
            details = { action, project: await v2Service.ensureRunning(name) };
          } else if (action === 'stop') {
            details = { action, project: await v2Service.ensureStopped(name) };
          } else if (action === 'bind_frontdesk') {
            const toolContext = invocation.source === 'tool' ? invocation.tool as any : null;
            const binding = {
              host: 'openclaw',
              agentId: agentId ?? toolContext?.agentId ?? null,
              sessionKey: sessionKey ?? toolContext?.sessionKey ?? toolContext?.session?.key ?? null,
            };
            await projectAgentAdapter.bindProject(binding);
            details = { action, project: manager.bindFrontdesk(name, binding) };
          } else if (action === 'unbind_frontdesk') {
            details = { action, project: manager.unbindFrontdesk(name) };
          } else if (action === 'frontdesk_status') {
            const project = manager.status(name);
            details = { action, projectId: project.id, frontdeskBinding: project.frontdeskBinding ?? null };
          } else if (action === 'decide') {
            if (!decision) throw new Error('decision is required for action decide');
            const project = manager.status(name);
            if (!project.frontdeskBinding) throw new Error('project has no bound Frontdesk');
            const toolContext = invocation.source === 'tool' ? invocation.tool as any : null;
            details = {
              action,
              result: await projectAgentAdapter.submitDecision({
                binding: project.frontdeskBinding,
                requester: {
                  agentId: toolContext?.agentId ?? null,
                  sessionKey: toolContext?.sessionKey ?? toolContext?.session?.key ?? null,
                },
                decision,
                submit: (value) => v2Service.submitDecision(name, value),
              }),
            };
          } else {
            throw new Error(`unsupported Ariad action: ${action}`);
          }
        }
        return { action, payloadJson: JSON.stringify(details) };
      },
    };
  },
});
