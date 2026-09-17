import { homedir } from 'node:os';
import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { AriadProjectManager, defaultProjectsRoot } from '../runtime/project-manager.js';
import { AriadSupervisor } from './ariad-supervisor.js';
import { contract } from './contract.js';
import { OpenClawRuntimeAdapter } from './openclaw-runtime-adapter.js';

function renderRoleMessage(role: string, context: Record<string, unknown>) {
  return [
    `You are executing the Ariad ${role} role.`,
    'Return only one JSON object with executionStatus, outcome, and optional result/failure fields.',
    'Do not communicate with other agents or the user. Complete only the assigned work and return the structured result.',
    `Context: ${JSON.stringify(context)}`,
  ].join('\n\n');
}

export default defineFeaturePlugin({
  contract,
  name: 'Ariad',
  description: 'Create and manage isolated Ariad autonomous engineering projects.',
  setup(api) {
    const projectsRoot = process.env.ARIAD_PROJECTS_ROOT || defaultProjectsRoot(homedir());
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

    const supervisor = new AriadSupervisor({
      manager,
      createController: (project) => {
        let active = false;
        return {
          async start() {
            await runtimeAdapter.install();
            await runtimeAdapter.probe();
            active = true;
          },
          async stop() { active = false; },
          status() { return { active, runtime: runtimeAdapter.id, projectId: project.id }; },
        };
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
