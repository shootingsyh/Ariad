import { homedir } from 'node:os';
import { Type } from 'typebox';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { AriadProjectManager, defaultProjectsRoot } from '../runtime/project-manager.js';
import { AriadSupervisor } from './ariad-supervisor.js';
import { OpenClawRuntimeAdapter } from './openclaw-runtime-adapter.js';

function toolResult(details: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(details) }],
    details,
  };
}

function renderRoleMessage(role: string, context: Record<string, unknown>) {
  return [
    `You are executing the Ariad ${role} role.`,
    'Return only one JSON object with executionStatus, outcome, and optional result/failure fields.',
    'Do not communicate with other agents or the user. Complete only the assigned work and return the structured result.',
    `Context: ${JSON.stringify(context)}`,
  ].join('\n\n');
}

export default definePluginEntry({
  id: 'ariad',
  name: 'Ariad',
  description: 'Create and manage isolated Ariad autonomous engineering projects.',
  register(api) {
    const config = (api.pluginConfig ?? {}) as {
      projectsRoot?: string;
      subagentAgentId?: string;
      subagentProvider?: string;
      subagentModel?: string;
      ciRuntimeProbeEnabled?: boolean;
    };
    const projectsRoot = config.projectsRoot || defaultProjectsRoot(homedir());
    const manager = new AriadProjectManager({ projectsRoot });
    const runtimeAdapter = new OpenClawRuntimeAdapter({
      subagent: api.runtime.subagent,
      agentId: config.subagentAgentId ?? 'main',
      provider: config.subagentProvider,
      model: config.subagentModel,
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

    api.registerTool((toolContext) => ({
      name: 'ariad_project',
      label: 'Ariad project',
      description: 'Create, list, inspect, start, or stop isolated Ariad projects. The current conversation becomes the project agent binding for newly created projects.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('create'), Type.Literal('list'), Type.Literal('status'), Type.Literal('start'), Type.Literal('stop'),
        ]),
        name: Type.Optional(Type.String({ description: 'Project name. Required except for list.' })),
        goal: Type.Optional(Type.String({ description: 'Initial project goal when creating a project.' })),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        const { action, name, goal } = params as { action: string; name?: string; goal?: string };
        if (action === 'list') return toolResult({ action, projects: supervisor.list() });
        if (!name) throw new Error(`name is required for action ${action}`);
        if (action === 'create') {
          const ctx = toolContext as any;
          const project = manager.create(name, {
            goal: goal ?? null,
            projectAgent: {
              host: 'openclaw',
              agentId: ctx.agentId ?? null,
              sessionKey: ctx.sessionKey ?? ctx.session?.key ?? null,
            },
          });
          return toolResult({ action, project: supervisor.status(project.id) });
        }
        if (action === 'status') return toolResult({ action, project: supervisor.status(name) });
        if (action === 'start') return toolResult({ action, project: await supervisor.ensureRunning(name) });
        if (action === 'stop') return toolResult({ action, project: await supervisor.ensureStopped(name) });
        throw new Error(`unsupported Ariad action: ${action}`);
      },
    }));

    if (config.ciRuntimeProbeEnabled) {
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
  },
});
