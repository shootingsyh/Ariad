import { homedir } from 'node:os';
import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { PromptRenderer } from '../../../src/llm/prompt-renderer.js';
import { GitSourceControlFinalizer } from '../../../src/git-source-control-finalizer.js';
import { AriadProjectManager, defaultProjectsRoot } from '../runtime/project-manager.js';
import { AriadProjectController } from '../runtime/project-controller.js';
import { AriadSupervisor } from './ariad-supervisor.js';
import { contract } from './contract.js';
import { OpenClawProjectAgentAdapter } from './openclaw-project-agent-adapter.js';
import { OpenClawRuntimeAdapter } from './openclaw-runtime-adapter.js';

const promptRenderer = new PromptRenderer();

function renderRoleMessage(role: string, context: Record<string, unknown>) {
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

    const supervisor = new AriadSupervisor({
      manager,
      createController: (project) => {
        const sourceControl = new GitSourceControlFinalizer({
          workspace: project.workspace,
          push: pushSourceControl,
        });
        return new AriadProjectController({
          project,
          runtimeAdapter,
          projectAgentAdapter,
          finalizeSourceControl: (input) => sourceControl.finalize(input),
          onError: (error: unknown) => api.logger.error(`Ariad project ${project.id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
        });
      },
    });

    api.registerService({
      id: 'ariad-supervisor',
      async start() { await supervisor.start(); },
      async stop() { await supervisor.stop(); },
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

      api.registerGatewayMethod('ariad.ci.project', async ({ params, respond }) => {
        try {
          const input = (params ?? {}) as { action?: string; name?: string; goal?: string };
          if (!input.action) throw new Error('action is required');
          if (input.action === 'create') {
            if (!input.name) throw new Error('name is required');
            const project = manager.create(input.name, {
              goal: input.goal ?? null,
              projectAgent: null,
            });
            respond(true, { project: supervisor.status(project.id) });
            return;
          }
          if (!input.name) throw new Error('name is required');
          if (input.action === 'start') {
            respond(true, { project: await supervisor.ensureRunning(input.name) });
            return;
          }
          if (input.action === 'status') {
            respond(true, { project: supervisor.status(input.name) });
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
        const { action, name, goal } = input;
        let details: unknown;
        if (action === 'list') {
          details = { action, projects: supervisor.list() };
        } else {
          if (!name) throw new Error(`name is required for action ${action}`);
          if (action === 'create') {
            const toolContext = invocation.source === 'tool' ? invocation.tool as any : null;
            const project = manager.create(name, {
              goal: goal ?? null,
              projectAgent: {
                host: 'openclaw',
                agentId: toolContext?.agentId ?? null,
                sessionKey: toolContext?.sessionKey ?? toolContext?.session?.key ?? null,
              },
            });
            details = { action, project: supervisor.status(project.id) };
          } else if (action === 'status') {
            details = { action, project: supervisor.status(name) };
          } else if (action === 'start') {
            details = { action, project: await supervisor.ensureRunning(name) };
          } else if (action === 'stop') {
            details = { action, project: await supervisor.ensureStopped(name) };
          } else {
            throw new Error(`unsupported Ariad action: ${action}`);
          }
        }
        return { action, payloadJson: JSON.stringify(details) };
      },
    };
  },
});
