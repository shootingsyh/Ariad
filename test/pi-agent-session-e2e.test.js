import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import { PiAgentSessionProvider, ARIAD_PI_RESULT_TOOL } from '../src/runtime/pi-agent-session-provider.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pi-e2e-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Pi E2E workspace\n');
  const db = path.join(root, 'state.db');
  return { root, workspace, db };
}

function makeRoles(store) {
  const roles = new RoleRegistry();

  roles.register('pm', {
    sessionPolicy: 'persistent',
    prepare: ({ task }) => ({
      provider: 'pi-agent-session',
      workspace: task.input.workspace,
      prompt: 'Review the requested project plan before technical planning.',
      context: { roleModelRef: 'fake/runtime' },
      sessionKey: 'pm:e2e',
    }),
    transition: () => ({ stage: 'pm', state: 'DONE' }),
  });

  roles.register('tech_lead', {
    sessionPolicy: 'persistent',
    prepare: ({ task }) => ({
      provider: 'pi-agent-session',
      workspace: task.input.workspace,
      prompt: task.input.replan
        ? 'Replan the project after new requirements.'
        : 'Produce the initial technical plan.',
      context: { roleModelRef: 'fake/runtime' },
      sessionKey: 'tl:e2e',
    }),
    transition: ({ task }) => {
      const project = store.getProject(task.projectId);
      store.updateProject(task.projectId, project.version, { deliveryEnabled: true });
      return { stage: 'tech_lead', state: 'DONE' };
    },
  });

  roles.register('developer', {
    prepare: ({ task }) => ({
      provider: 'pi-agent-session',
      workspace: task.input.workspace,
      prompt: `Implement ${task.id} using the workspace tools.`,
      context: { roleModelRef: 'fake/runtime' },
    }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'tester', state: 'READY' }
      : { stage: 'developer', state: 'READY' },
  });

  roles.register('tester', {
    prepare: ({ task }) => ({
      provider: 'pi-agent-session',
      workspace: task.input.workspace,
      prompt: `Verify ${task.id} using fresh evidence.`,
      context: { roleModelRef: 'fake/runtime' },
    }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'reviewer', state: 'READY' }
      : { stage: 'developer', state: 'READY' },
  });

  roles.register('reviewer', {
    prepare: ({ task }) => ({
      provider: 'pi-agent-session',
      workspace: task.input.workspace,
      prompt: `Review ${task.id} and the tester evidence.`,
      context: { roleModelRef: 'fake/runtime' },
    }),
    transition: ({ result }) => result.outcome === 'PASS'
      ? { stage: 'reviewer', state: 'DONE' }
      : { stage: 'developer', state: 'READY' },
  });

  return roles;
}

function scriptedPiSessionFactory(workspace) {
  const roleRuns = new Map();
  const toolCalls = [];

  async function createRunSession(spec) {
    const runNo = (roleRuns.get(spec.role) ?? 0) + 1;
    roleRuns.set(spec.role, runNo);

    const faux = fauxProvider({
      provider: 'fake',
      models: [{ id: 'runtime', reasoning: true }],
    });

    const workTool = spec.role === 'pm'
      ? fauxToolCall('read', { path: 'README.md' })
      : spec.role === 'tech_lead'
        ? fauxToolCall('write', {
            path: spec.prompt.includes('Replan') ? 'replan.txt' : 'plan.txt',
            content: spec.prompt.includes('Replan') ? 'replanned\n' : 'planned\n',
          })
        : spec.role === 'developer'
          ? fauxToolCall('write', {
              path: spec.taskId === 'T2' ? 'feature-2.txt' : 'feature-1.txt',
              content: `implemented by developer run ${runNo}\n`,
            })
          : fauxToolCall('read', {
              path: spec.taskId === 'T2' ? 'feature-2.txt' : 'feature-1.txt',
            });

    const testerShouldFail = spec.role === 'tester' && spec.taskId === 'T1' && runNo === 1;
    const outcome = testerShouldFail ? 'NOT_PASS' : 'PASS';

    faux.setResponses([
      fauxAssistantMessage([workTool], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall(ARIAD_PI_RESULT_TOOL, {
          outcome,
          summary: `${spec.role} run ${runNo} ${outcome}`,
          keyPoints: [`role:${spec.role}`, `run:${runNo}`],
          artifacts: [],
          result: { role: spec.role, runNo },
        }),
      ], { stopReason: 'toolUse' }),
    ]);

    const runtime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);

    let terminalResult = null;
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: workspace,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on('tool_execution_start', event => {
          toolCalls.push({ role: spec.role, tool: event.toolName });
        });
        pi.registerTool({
          name: ARIAD_PI_RESULT_TOOL,
          label: 'Ariad role result',
          description: 'Submit the final Ariad role result.',
          parameters: Type.Object({
            outcome: Type.String(),
            summary: Type.String(),
            keyPoints: Type.Optional(Type.Array(Type.String())),
            artifacts: Type.Optional(Type.Array(Type.String())),
            result: Type.Optional(Type.Any()),
          }, { additionalProperties: false }),
          async execute(_toolCallId, params) {
            terminalResult = {
              outcome: params.outcome,
              summary: params.summary,
              keyPoints: params.keyPoints ?? [],
              artifacts: params.artifacts ?? [],
              result: params.result ?? null,
            };
            return {
              content: [{ type: 'text', text: 'sealed' }],
              details: { accepted: true },
              terminate: true,
            };
          },
        });
      }],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir: workspace,
      modelRuntime: runtime,
      model: faux.getModel(),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(workspace),
      tools: ['read', 'write', ARIAD_PI_RESULT_TOOL],
    });
    await session.bindExtensions({ mode: 'json' });

    return {
      session,
      getTerminalResult: () => terminalResult,
    };
  }

  return { createRunSession, roleRuns, toolCalls };
}

async function drive({ scheduler, supervisor, store, projectId, done }, limit = 500) {
  for (let i = 0; i < limit; i += 1) {
    await supervisor.audit(projectId);
    await scheduler.tick(projectId);
    if (done()) return;
    await sleep(5);
  }
  throw new Error('Pi E2E did not settle');
}

test('Pi host preserves Ariad PM/TL/Dev/Test/Review scheduling and replan lifecycle', async () => {
  const { root, workspace, db } = tempProject();
  try {
    const store = new SQLiteV2Store(db);
    store.createProject({
      id: 'P',
      spec: 'Pi-hosted Ariad E2E',
      workspace,
      deliveryEnabled: false,
    });

    store.createControlFlow({
      projectId: 'P',
      flowId: 'plan:1',
      tasks: [
        {
          id: 'plan:pm:1',
          stage: 'pm',
          state: 'READY',
          dependsOn: [],
          input: { workspace },
        },
        {
          id: 'plan:tl:1',
          stage: 'tech_lead',
          state: 'READY',
          dependsOn: ['plan:pm:1'],
          input: { workspace },
        },
      ],
    });

    store.createTask({
      id: 'T1',
      projectId: 'P',
      stage: 'developer',
      state: 'READY',
      dependsOn: [],
      input: { workspace },
    });

    const scripted = scriptedPiSessionFactory(workspace);
    const provider = new PiAgentSessionProvider({
      createRunSession: scripted.createRunSession,
    });
    const providers = new ProviderRegistry();
    providers.register(provider);
    const roles = makeRoles(store);
    const resources = new ResourcePool({});

    const scheduler = new V2Scheduler({ store, roles, providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });

    await drive({
      scheduler,
      supervisor,
      store,
      projectId: 'P',
      done: () =>
        store.getTask('plan:pm:1').state === 'DONE'
        && store.getTask('plan:tl:1').state === 'DONE'
        && store.getTask('T1').state === 'DONE',
    });

    const t1 = store.getTask('T1');
    assert.deepEqual(
      t1.history
        .filter(entry => entry.type === 'ROLE_RESULT')
        .map(entry => [entry.role, entry.outcome]),
      [
        ['developer', 'PASS'],
        ['tester', 'NOT_PASS'],
        ['developer', 'PASS'],
        ['tester', 'PASS'],
        ['reviewer', 'PASS'],
      ],
    );
    assert.equal(fs.existsSync(path.join(workspace, 'plan.txt')), true);
    assert.equal(fs.existsSync(path.join(workspace, 'feature-1.txt')), true);

    // Replan cycle: close delivery gate, run PM/TL again, then allow a new task.
    let project = store.getProject('P');
    store.updateProject('P', project.version, { deliveryEnabled: false });
    store.createControlFlow({
      projectId: 'P',
      flowId: 'plan:2',
      tasks: [
        {
          id: 'plan:pm:2',
          stage: 'pm',
          state: 'READY',
          dependsOn: [],
          input: { workspace, replan: true },
        },
        {
          id: 'plan:tl:2',
          stage: 'tech_lead',
          state: 'READY',
          dependsOn: ['plan:pm:2'],
          input: { workspace, replan: true },
        },
      ],
    });
    store.createTask({
      id: 'T2',
      projectId: 'P',
      stage: 'developer',
      state: 'READY',
      dependsOn: ['T1'],
      input: { workspace },
    });

    await drive({
      scheduler,
      supervisor,
      store,
      projectId: 'P',
      done: () =>
        store.getTask('plan:pm:2').state === 'DONE'
        && store.getTask('plan:tl:2').state === 'DONE'
        && store.getTask('T2').state === 'DONE',
    });

    assert.equal(fs.existsSync(path.join(workspace, 'replan.txt')), true);
    assert.equal(fs.existsSync(path.join(workspace, 'feature-2.txt')), true);
    assert.deepEqual(
      store.getTask('T2').history
        .filter(entry => entry.type === 'ROLE_RESULT')
        .map(entry => [entry.role, entry.outcome]),
      [
        ['developer', 'PASS'],
        ['tester', 'PASS'],
        ['reviewer', 'PASS'],
      ],
    );

    assert.equal(scripted.roleRuns.get('pm'), 2);
    assert.equal(scripted.roleRuns.get('tech_lead'), 2);
    assert.equal(scripted.roleRuns.get('developer'), 3);
    assert.equal(scripted.roleRuns.get('tester'), 3);
    assert.equal(scripted.roleRuns.get('reviewer'), 2);

    const tools = scripted.toolCalls.map(entry => entry.tool);
    assert.ok(tools.includes('read'));
    assert.ok(tools.includes('write'));
    assert.ok(tools.includes(ARIAD_PI_RESULT_TOOL));

    await provider.close();
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
