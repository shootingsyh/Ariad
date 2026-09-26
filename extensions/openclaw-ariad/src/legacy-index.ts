import { homedir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { toolPluginMetadataSymbol } from 'openclaw/plugin-sdk/tool-plugin';
import { PromptRenderer } from '../../../src/llm/prompt-renderer.js';
import { SQLiteV2Store } from '../../../src/v2/sqlite-store.js';
import { RoleRegistry } from '../../../src/v2/role-registry.js';
import { ProviderRegistry } from '../../../src/v2/provider-registry.js';
import { ResourcePool } from '../../../src/v2/resource-pool.js';
import { V2Scheduler } from '../../../src/v2/scheduler.js';
import { V2Supervisor } from '../../../src/v2/supervisor.js';
import { AriadProjectManager, defaultProjectsRoot } from '../runtime/project-manager.js';
import {
  ARIAD_MODEL_ROLES,
  normalizeRoleModels,
  requireCompleteRoleModels,
} from '../runtime/role-models.js';
import { contract } from './contract.js';
import { OpenClawProjectAgentAdapter } from './openclaw-project-agent-adapter.js';
import { OpenClawRuntimeAdapter } from './openclaw-runtime-adapter.js';
import { createAgentSessionSubagentFacade } from './agent-session-subagent-facade.js';
import { OpenClawV2Provider } from './openclaw-v2-provider.js';
import { AriadV2Service } from './ariad-v2-service.js';
import { detectExecutionCapabilities } from '../runtime/execution-capabilities.js';
import { detectExecutionProvenance } from '../runtime/provenance.js';
import { AriadDashboardService } from './dashboard-service.js';
import { AriadMcpRoleResultBridge } from './mcp-role-result-bridge.js';
import {
  CODEX_ROLE_RESULT_TOOL_NAME,
  codexRoleResultToolMetadata,
  registerCodexRoleResultTool,
  registerRoleResultTools,
  roleResultToolMetadata,
  roleResultToolName,
} from './role-result-tools.js';

const promptRenderer = new PromptRenderer();

function renderRoleMessage(role: string, context: Record<string, unknown>) {
  const toolName = roleResultToolName(role);
  const resultContract = toolName && typeof context.projectId === 'string' && typeof context.taskId === 'string'
    ? [
        '',
        'ARIAD RESULT CONTRACT',
        `Before ending this role, you MUST successfully call ${toolName} exactly once.`,
        `If ${toolName} is unavailable, call the MCP tool ariad_role_result exactly once with the same result payload. This is the required Codex path. If ariad_role_result is unavailable but ${CODEX_ROLE_RESULT_TOOL_NAME} is available, call ${CODEX_ROLE_RESULT_TOOL_NAME} as a legacy compatibility path. Never emit terminal JSON as a substitute for an accepted result tool call.`,
        `Pass the exact Ariad attemptId from ARIAD RUNTIME CONTEXT: ${String(context.attemptId ?? '')}`,
        'The accepted result tool call is the authoritative completion signal. Do not substitute terminal prose or a JSON final answer for the tool call.',
        'If the tool rejects your arguments, correct them and call it again. Failed submissions do not count.',
        'This tool call MUST be your final action. Finish all work first, then call it.',
        'Once accepted, Ariad seals the result and terminates this execution. Do not expect another model turn and do not plan to emit prose afterward.',
      ].join('\n')
    : '';

  if (typeof context.v2Prompt === 'string' && context.v2Prompt.trim()) {
    const { v2Prompt, ...runtimeContext } = context;
    return [
      v2Prompt,
      '',
      'ARIAD RUNTIME CONTEXT',
      JSON.stringify(runtimeContext),
      resultContract,
    ].filter(Boolean).join('\n');
  }
  const rendered = promptRenderer.render(role, context);
  return [
    rendered.messages
      .map((message: { role: string; content: string }) => `[${message.role.toUpperCase()}]\n${message.content}`)
      .join('\n\n'),
    resultContract,
  ].filter(Boolean).join('\n\n');
}

const plugin = defineFeaturePlugin({
  contract,
  name: 'Ariad',
  description: 'Create and manage isolated Ariad autonomous engineering projects.',
  setup(api) {
    const projectsRoot = process.env.ARIAD_PROJECTS_ROOT || defaultProjectsRoot(homedir());
    const pushSourceControl = process.env.ARIAD_SOURCE_CONTROL_PUSH !== '0';
    const manager = new AriadProjectManager({ projectsRoot });
    const modelCatalogPath = join(projectsRoot, '.runtime', 'model-catalog.json');
    let modelCatalog: {
      refreshedAt: string | null;
      source: string;
      models: any[];
      error: string | null;
    } = { refreshedAt: null, source: 'none', models: [], error: null };
    const runtimeAgentId = process.env.ARIAD_OPENCLAW_AGENT_ID || 'main';
    const roleExecutionRuntime = process.env.ARIAD_EXECUTION_MODE === 'agent-session'
      ? createAgentSessionSubagentFacade(api, { agentId: runtimeAgentId, pluginId: 'ariad' })
      : api.runtime.subagent;
    if (process.env.ARIAD_EXECUTION_MODE === 'agent-session') {
      api.logger?.info?.(`Ariad execution mode: agent-session (host agent ${runtimeAgentId})`);
    }
    const runtimeAdapter = new OpenClawRuntimeAdapter({
      subagent: roleExecutionRuntime,
      agentId: runtimeAgentId,
      renderMessage: renderRoleMessage,
      cancelRun: async (runId) => {
        await api.runtime.gateway.request('sessions.abort', { runId });
      },
    });
    const projectAgentAdapter = new OpenClawProjectAgentAdapter({ gateway: api.runtime.gateway });
    const v2Provider = new OpenClawV2Provider(runtimeAdapter, {
      resolveModelRef: (projectId, role) => (manager.status(projectId).roleModels as Record<string, string | undefined>)?.[role] ?? null,
    });
    const readModelOverridePolicy = () => {
      const cfg = (api.runtime as any)?.config?.current?.() ?? {};
      const subagent = cfg?.plugins?.entries?.ariad?.subagent ?? {};
      return {
        allowModelOverride: subagent.allowModelOverride === true,
        allowedModels: Array.isArray(subagent.allowedModels)
          ? subagent.allowedModels.filter((value: unknown) => typeof value === 'string' && value.trim()).map((value: string) => value.trim())
          : [],
      };
    };

    const assertModelOverridePolicy = (roleModels?: Record<string, string>) => {
      const policy = readModelOverridePolicy();
      if (!policy.allowModelOverride) {
        throw new Error(
          'Ariad explicit role models require plugins.entries.ariad.subagent.allowModelOverride=true in OpenClaw config'
        );
      }
      if (roleModels && policy.allowedModels.length > 0 && !policy.allowedModels.includes('*')) {
        for (const [role, ref] of Object.entries(roleModels)) {
          if (!policy.allowedModels.includes(ref)) {
            throw new Error(
              `Ariad model ${ref} for ${role} is not allowed by plugins.entries.ariad.subagent.allowedModels`
            );
          }
        }
      }
      return policy;
    };

    const normalizeDiscoveredModels = (payload: any) => {
      const raw = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.models)
          ? payload.models
          : Array.isArray(payload?.data)
            ? payload.data
            : [];
      return raw.map((model: any) => {
        const provider = model.provider ?? model.providerId ?? model.vendor ?? null;
        const id = model.id ?? model.model ?? model.modelId ?? null;
        const ref = model.ref ?? model.modelRef ?? (provider && id ? `${provider}/${id}` : null);
        return {
          ref,
          provider,
          id,
          name: model.name ?? model.displayName ?? null,
          available: model.available ?? null,
          local: model.local ?? null,
          supportsTools: model.supportsTools ?? model.capabilities?.tools ?? null,
          contextTokens: model.contextTokens ?? model.contextWindow ?? null,
        };
      }).filter((model: any) => typeof model.ref === 'string' && model.ref.includes('/'));
    };

    const refreshOpenClawModelCatalog = (reason = 'manual') => {
      try {
        const cliEntry = process.argv[1];
        if (!cliEntry) throw new Error('OpenClaw CLI entrypoint is unavailable');
        const child = spawnSync(process.execPath, [cliEntry, 'models', 'list', '--all', '--json'], {
          env: process.env,
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 8 * 1024 * 1024,
        });
        if (child.error) throw child.error;
        if (child.status !== 0) {
          throw new Error((child.stderr || child.stdout || `openclaw models list exited ${child.status}`).trim());
        }
        const payload = JSON.parse(child.stdout || '{}');
        modelCatalog = {
          refreshedAt: new Date().toISOString(),
          source: `openclaw-cli:${reason}`,
          models: normalizeDiscoveredModels(payload),
          error: null,
        };
      } catch (error) {
        modelCatalog = {
          ...modelCatalog,
          refreshedAt: new Date().toISOString(),
          source: `openclaw-cli:${reason}`,
          error: error instanceof Error ? error.message : String(error),
        };
        api.logger?.warn?.(
          `Ariad model catalog refresh failed; configured role model refs remain allowed and will be validated at runtime: ${modelCatalog.error}`
        );
      }
      try {
        mkdirSync(join(projectsRoot, '.runtime'), { recursive: true });
        writeFileSync(modelCatalogPath, JSON.stringify(modelCatalog, null, 2) + '\n');
      } catch (error) {
        api.logger?.warn?.(
          `Ariad could not persist model catalog cache: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return modelCatalog;
    };

    const listOpenClawModels = () => refreshOpenClawModelCatalog('models-action').models;

    const validateSelectedRoleModels = (roleModels: Record<string, string>, { refresh = false } = {}) => {
      assertModelOverridePolicy(roleModels);
      const catalog = refresh || modelCatalog.refreshedAt == null
        ? refreshOpenClawModelCatalog('role-model-validation')
        : modelCatalog;
      const byRef = new Map<string, any>(catalog.models.map((model: any) => [model.ref, model]));
      const warnings: string[] = [];
      for (const [role, ref] of Object.entries(roleModels)) {
        const model = byRef.get(ref);
        if (!model) {
          warnings.push(`${role}: ${ref} is not in the cached OpenClaw CLI model catalog; validation is deferred to runtime`);
          continue;
        }
        if (model.available === false) warnings.push(`${role}: ${ref} is currently reported unavailable; runtime may fail`);
        if (model.supportsTools === false) warnings.push(`${role}: ${ref} is reported without tool support; Ariad role execution may fail`);
      }
      for (const warning of warnings) api.logger?.warn?.(`Ariad role model warning: ${warning}`);
      return { catalog, warnings };
    };

    const dashboard = new AriadDashboardService({
      manager,
      host: process.env.ARIAD_DASHBOARD_HOST || '127.0.0.1',
      port: Number(process.env.ARIAD_DASHBOARD_PORT || 18791),
      logger: api.logger,
    });

    const executionCapabilities = detectExecutionCapabilities();
    const executionProvenance = detectExecutionProvenance();
    const v2Service = new AriadV2Service({
      manager,
      provider: v2Provider,
      pushSourceControl,
      logger: api.logger,
      executionCapabilities,
      executionProvenance,
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

    const terminateAcceptedAttempt = (attemptId: string) => {
      // Return the accepted tool result before aborting the exact run.
      // sessions.abort may wait for settlement, so never await it here.
      setTimeout(() => {
        void runtimeAdapter.terminateAttempt(attemptId).catch((error) => {
          api.logger?.warn?.(
            `Ariad failed to terminate accepted role attempt ${attemptId}: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }, 0);
    };

    const mcpRoleResultBridge = new AriadMcpRoleResultBridge({
      projectsRoot,
      logger: api.logger,
      resolveAttempt: (attemptId) => runtimeAdapter.getAttemptRuntimeBinding(attemptId),
      submit: (attemptId, role, payload) => v2Service.submitRoleResultByAttempt(attemptId, role, payload),
      terminate: terminateAcceptedAttempt,
    });

    registerRoleResultTools({
      api,
      submit: (attemptId, role, payload) => v2Service.submitRoleResultByAttempt(attemptId, role, payload),
      terminate: terminateAcceptedAttempt,
    });

    registerCodexRoleResultTool({
      api,
      resolveAttempt: (attemptId) => runtimeAdapter.getAttemptRuntimeBinding(attemptId),
      submit: (attemptId, role, payload) => v2Service.submitRoleResultByAttempt(attemptId, role, payload),
      terminate: terminateAcceptedAttempt,
    });

    api.registerService({
      id: 'ariad-mcp-role-result-bridge',
      async start() { await mcpRoleResultBridge.start(); },
      async stop() { await mcpRoleResultBridge.stop(); },
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
                  roleModelRef: 'ariadfake/fake',
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
          const input = (params ?? {}) as { action?: string; name?: string; goal?: string; request?: string; mode?: 'NEW' | 'TAKEOVER'; sourcePath?: string; roleModels?: Record<string, string> };
          if (!input.action) throw new Error('action is required');
          if (input.action === 'create') {
            if (!input.name) throw new Error('name is required');
            const project = manager.create(input.name, {
              goal: input.goal ?? null,
              mode: input.mode ?? null,
              sourcePath: input.sourcePath ?? null,
              roleModels: requireCompleteRoleModels(input.roleModels ?? {}),
              projectAgent: null,
            });
            respond(true, { project: v2Service.status(project.id) });
            return;
          }
          if (!input.name) throw new Error('name is required');
          if (input.action === 'set_role_models') {
            const selectedRoleModels = normalizeRoleModels((input.roleModels ?? {}) as Record<string, string>) as Record<string, string>;
            if (Object.keys(selectedRoleModels).length === 0) throw new Error('roleModels is required for set_role_models');
            const validation = validateSelectedRoleModels(selectedRoleModels, { refresh: true });
            respond(true, {
              project: manager.setRoleModels(input.name, selectedRoleModels),
              modelWarnings: validation.warnings,
              catalogSource: validation.catalog.source,
            });
            return;
          }
          if (input.action === 'start' || input.action === 'resume') {
            const project = manager.status(input.name);
            validateSelectedRoleModels(project.roleModels as Record<string, string>);
            respond(true, { project: input.action === 'start'
              ? await v2Service.ensureRunning(input.name)
              : await v2Service.ensureResumed(input.name) });
            return;
          }
          if (input.action === 'pause') {
            respond(true, { project: await v2Service.ensurePaused(input.name) });
            return;
          }
          if (input.action === 'iterate') {
            if (!input.request?.trim()) throw new Error('request is required for action iterate');
            respond(true, { result: await v2Service.iterate(input.name, input.request) });
            return;
          }
          if (input.action === 'status') {
            respond(true, { project: v2Service.status(input.name) });
            return;
          }
          if (input.action === 'adopt') {
            if (!input.sourcePath) throw new Error('sourcePath is required for adopt');
            respond(true, { project: (manager as any).adopt(input.name, input.sourcePath, { roleModels: input.roleModels ?? null }) });
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
        const { action, name, goal, request, mode, sourcePath, decision, agentId, sessionKey, roleModels } = input;
        let details: unknown;
        if (action === 'list') {
          details = { action, projects: v2Service.list() };
        } else if (action === 'models') {
          const models = listOpenClawModels();
          const project = name ? manager.status(name) : null;
          details = {
            action,
            requiredRoles: ARIAD_MODEL_ROLES,
            roleModels: project?.roleModels ?? null,
            missingRoles: project ? ARIAD_MODEL_ROLES.filter(role => !(project.roleModels as Record<string, string | undefined>)?.[role]) : null,
            modelOverridePolicy: readModelOverridePolicy(),
            models,
          };
        } else {
          if (!name) throw new Error(`name is required for action ${action}`);
          if (action === 'create') {
            const toolContext = invocation.source === 'tool' ? invocation.tool as any : null;
            const selectedRoleModels = requireCompleteRoleModels((roleModels ?? {}) as Record<string, string>) as Record<string, string>;
            const modelValidation = validateSelectedRoleModels(selectedRoleModels, { refresh: true });
            const project = manager.create(name, {
              goal: goal ?? null,
              mode: mode ?? null,
              sourcePath: sourcePath ?? null,
              roleModels: selectedRoleModels,
              frontdeskBinding: {
                host: 'openclaw',
                agentId: toolContext?.agentId ?? null,
                sessionKey: toolContext?.sessionKey ?? toolContext?.session?.key ?? null,
              },
            });
            details = { action, project: v2Service.status(project.id), modelWarnings: modelValidation.warnings };
          } else if (action === 'set_role_models') {
            const selectedRoleModels = normalizeRoleModels((roleModels ?? {}) as Record<string, string>) as Record<string, string>;
            if (Object.keys(selectedRoleModels).length === 0) throw new Error('roleModels is required for set_role_models');
            const modelValidation = validateSelectedRoleModels(selectedRoleModels, { refresh: true });
            details = {
              action,
              project: manager.setRoleModels(name, selectedRoleModels),
              modelWarnings: modelValidation.warnings,
              catalogSource: modelValidation.catalog.source,
            };
          } else if (action === 'status') {
            details = { action, project: v2Service.status(name) };
          } else if (action === 'adopt') {
            if (!sourcePath) throw new Error('sourcePath is required for action adopt');
            const adoptRoleModels = roleModels == null
              ? null
              : requireCompleteRoleModels(roleModels as Record<string, string>);
            if (adoptRoleModels) validateSelectedRoleModels(adoptRoleModels as Record<string, string>, { refresh: true });
            details = { action, project: (manager as any).adopt(name, sourcePath, { roleModels: adoptRoleModels }) };
          } else if (action === 'start' || action === 'resume') {
            const project = manager.status(name);
            const configuredRoleModels = requireCompleteRoleModels(
              (project.roleModels ?? {}) as Record<string, string>
            ) as Record<string, string>;
            const modelValidation = validateSelectedRoleModels(configuredRoleModels);
            details = {
              action,
              project: action === 'start'
                ? await v2Service.ensureRunning(name)
                : await v2Service.ensureResumed(name),
              modelWarnings: modelValidation.warnings,
            };
          } else if (action === 'pause') {
            details = { action, project: await v2Service.ensurePaused(name) };
          } else if (action === 'iterate') {
            if (!request?.trim()) throw new Error('request is required for action iterate');
            details = { action, result: await v2Service.iterate(name, request) };
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

const staticMetadata = (plugin as any)[toolPluginMetadataSymbol];
if (staticMetadata?.tools) {
  staticMetadata.tools.push(...roleResultToolMetadata(), codexRoleResultToolMetadata());
}

export default plugin;
