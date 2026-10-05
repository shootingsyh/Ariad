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
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import { FunctionProvider } from '../src/v2/function-provider.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function writeCall(filePath, value) {
  return fauxToolCall('write', {
    path: filePath,
    content: JSON.stringify(value, null, 2) + '\n',
  });
}

function featureArtifacts() {
  return [
    writeCall('.ariad/artifacts/planner/logical/project.json', {
      id: 'project',
      title: 'Project',
      summary: 'A tiny deterministic project.',
      parentId: null,
    }),
    writeCall('.ariad/artifacts/planner/interfaces/features/project.json', {
      version: 1,
      nodeId: 'project',
      nodeType: 'feature',
      decomposition: { kind: 'leaf', reason: 'Single feature is sufficient.' },
      interfaces: [{
        id: 'project-run',
        kind: 'executor',
        visibility: 'exported',
        contract: {
          input: ['request'],
          output: ['result'],
          sideEffects: ['writes feature.txt'],
        },
      }],
      imports: [],
      integrationScenarios: [],
      bindings: [],
      featureTasks: [{
        id: 'project-impl',
        title: 'Implement project feature',
        intent: 'Implement the project-run behavior.',
        acceptanceCriteria: ['AC-1: project feature works.'],
        testStrategy: 'Exercise the supported behavior.',
        verification: [],
        interfaceIds: ['project-run'],
      }],
    }),
  ];
}

function milestoneArtifacts() {
  return [
    writeCall('.ariad/artifacts/planner/milestones/M1.json', {
      id: 'M1',
      title: 'Working slice',
      goal: 'Deliver the working project feature.',
      parentId: null,
      dependsOn: [],
      logicalRefs: ['project'],
      acceptanceCriteria: ['The supported behavior works.'],
      testStrategy: 'Run the feature behavior end to end.',
      tasks: [{
        id: 'project-impl',
        title: 'Implement project feature',
        intent: 'Implement the project-run behavior.',
        dependsOn: [],
        logicalRefs: ['project'],
        acceptanceCriteria: ['AC-1: project feature works.'],
        testStrategy: 'Exercise the supported behavior.',
        verification: [],
      }],
    }),
    writeCall('.ariad/artifacts/planner/interfaces/milestones/M1.json', {
      version: 1,
      nodeId: 'M1',
      nodeType: 'milestone',
      decomposition: { kind: 'leaf', reason: 'Single milestone is sufficient.' },
      interfaces: [{
        id: 'm1-run',
        kind: 'executor',
        visibility: 'exported',
        contract: {
          input: ['request'],
          output: ['result'],
          sideEffects: [],
        },
      }],
      imports: [],
      featureUses: [{
        featureId: 'project',
        interfaceId: 'project-run',
        purpose: 'Exercise the shipped feature.',
      }],
      integrationScenarios: [{
        id: 'm1-flow',
        description: 'Run the project feature through the milestone.',
        uses: [{ graph: 'feature', nodeId: 'project', interfaceId: 'project-run' }],
      }],
      taskLinks: [{
        taskId: 'project-impl',
        addDependsOn: [],
        addVerification: [],
      }],
      integrationTasks: [],
    }),
  ];
}

function makeRealPlannerPiFactory(workspace) {
  const counters = new Map();
  const invocations = [];

  async function createRunSession(spec) {
    const key = `${spec.role}:${spec.context?.v2Prompt?.includes('PLANNER') ? 'planner' : 'delivery'}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    const prompt = String(spec.context?.v2Prompt ?? '');
    invocations.push({ role: spec.role, taskId: spec.taskId, prompt, run: n });

    const faux = fauxProvider({
      provider: 'fake',
      models: [{ id: 'runtime', reasoning: true }],
    });

    let workCalls = [];
    let outcome = 'PASS';
    let summary = `${spec.role} completed`;
    let result = {};

    if (spec.role === 'tech_lead') {
      outcome = 'PLANNED';
      if (prompt.includes('FEATURE FRONTIER PHASE')) {
        workCalls = featureArtifacts();
      } else if (prompt.includes('MILESTONE FRONTIER PHASE')) {
        workCalls = milestoneArtifacts();
      } else if (prompt.includes('repair') || prompt.includes('REPAIR')) {
        workCalls = [fauxToolCall('read', { path: '.ariad/artifacts/planner/logical/project.json' })];
      } else {
        workCalls = [fauxToolCall('read', { path: '.ariad/artifacts/planner/milestones/M1.json' })];
      }
    } else if (spec.role === 'tech_lead_critic') {
      const criticRun = counters.get('critic-total') ?? 0;
      counters.set('critic-total', criticRun + 1);
      if (criticRun === 0) {
        outcome = 'ISSUES';
        result = {
          issues: [{ severity: 'major', message: 'Recheck the compiled task boundary.' }],
          summary: 'One repair round requested.',
        };
      } else {
        outcome = 'CLEAN';
        result = { issues: [], summary: 'Plan is clean.' };
      }
      workCalls = [fauxToolCall('read', { path: '.ariad/artifacts/planner/interfaces/features/project.json' })];
    } else if (spec.role === 'pm') {
      const pmRun = counters.get('pm-total') ?? 0;
      counters.set('pm-total', pmRun + 1);
      if (pmRun === 0) {
        outcome = 'PLAN_REVISION_REQUIRED';
        result = {
          reason: 'Run one bounded replan pass.',
          startDelivery: false,
          guidance: 'Re-review the current plan without broadening scope.',
        };
      } else {
        outcome = 'PLAN_ACCEPTED';
        result = {
          reason: 'Validated plan accepted.',
          startDelivery: true,
        };
      }
      workCalls = [fauxToolCall('read', { path: '.ariad/artifacts/planner/milestones/M1.json' })];
    } else if (spec.role === 'developer') {
      outcome = 'PASS';
      if (n === 1) {
        workCalls = [fauxToolCall('write', {
          path: 'feature.js',
          content: "export const projectRun = () => 'implemented';\n",
        })];
        result = {};
      } else {
        workCalls = [fauxToolCall('read', { path: 'feature.js' })];
        result = {
          interfaceRealizations: [{
            interfaceId: 'project-run',
            anchors: [{
              kind: 'symbol',
              file: 'feature.js',
              symbol: 'projectRun',
            }],
          }],
        };
      }
    } else if (spec.role === 'tester') {
      outcome = 'PASS';
      workCalls = [fauxToolCall('read', { path: 'feature.js' })];
      result = {
        criteria: [{
          criterionId: 'AC-1',
          status: 'SATISFIED',
          evidenceType: 'behavioral',
          evidence: ['feature.js exports projectRun'],
          reason: 'Observed the implemented behavior.',
        }],
      };
    } else if (spec.role === 'reviewer') {
      outcome = 'PASS';
      workCalls = [fauxToolCall('read', { path: 'feature.js' })];
    }

    faux.setResponses([
      fauxAssistantMessage(workCalls, { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall(ARIAD_PI_RESULT_TOOL, {
          outcome,
          summary,
          keyPoints: [],
          artifacts: [],
          result,
        }),
      ], { stopReason: 'toolUse' }),
    ]);

    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
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
        pi.registerTool({
          name: ARIAD_PI_RESULT_TOOL,
          label: 'Ariad role result',
          description: 'Submit final Ariad role result.',
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

    return { session, getTerminalResult: () => terminalResult };
  }

  return { createRunSession, counters, invocations };
}

async function drive(store, scheduler, supervisor, projectId, predicate, limit = 1000) {
  for (let i = 0; i < limit; i += 1) {
    await supervisor.audit(projectId);
    await scheduler.tick(projectId);
    if (predicate()) return;
    await sleep(5);
  }
  const project = store.getProject(projectId);
  const tasks = store.listTasks(projectId).map(task => ({
    id: task.id,
    stage: task.stage,
    state: task.state,
    flowId: task.flowId ?? null,
    purpose: task.input?.purpose ?? null,
    dependsOn: task.dependsOn ?? [],
    lastHistory: (task.history ?? []).slice(-3),
  }));
  const requests = store.listPlanningRequests(projectId);
  throw new Error('real planner Pi E2E did not settle: ' + JSON.stringify({
    project: {
      deliveryEnabled: project?.deliveryEnabled,
      planningModelVersion: project?.planningModelVersion,
    },
    requests,
    tasks,
  }));
}

test('real Ariad planner runs critic repair, PM replan, delivery, test, and review through Pi', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pi-real-planner-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const stateDb = path.join(root, 'state.db');
  const artifactRoot = path.join(workspace, '.ariad', 'artifacts');

  const store = new SQLiteV2Store(stateDb);
  const providerHarness = makeRealPlannerPiFactory(workspace);
  const piProvider = new PiAgentSessionProvider({ createRunSession: providerHarness.createRunSession });

  try {
    store.createProject({
      id: 'P-real',
      spec: 'Build one deterministic feature.',
      workspace,
      deliveryEnabled: false,
      pmBinding: 'pm:P-real',
    });
    store.enqueuePlanningRequest({
      id: 'initial-plan',
      projectId: 'P-real',
      request: {
        purpose: 'INITIAL_PLAN',
        instruction: 'Create the smallest complete plan.',
      },
    });

    let replanSequence = 0;
    const definitions = createDefaultV2Roles({
      store,
      providerId: piProvider.id,
      codeProviderId: 'ariad-code',
      workspace,
      artifactRoot,
      resolveRoleExecutionMetadata: () => ({ modelRef: 'fake/runtime' }),
      enqueuePlanning: ({ request }) => {
        replanSequence += 1;
        store.enqueuePlanningRequest({
          id: `auto-replan-${replanSequence}`,
          projectId: 'P-real',
          request,
        });
      },
    });
    const roles = new RoleRegistry();
    for (const [name, definition] of Object.entries(definitions)) roles.register(name, definition);

    const providers = new ProviderRegistry();
    providers.register(piProvider);
    providers.register(new FunctionProvider());

    const resources = new ResourcePool({ 'local-llm': 1 });
    const scheduler = new V2Scheduler({ store, roles, providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });

    await drive(
      store,
      scheduler,
      supervisor,
      'P-real',
      () => {
        const project = store.getProject('P-real');
        const delivery = store.getTask('project-impl');
        return project?.deliveryEnabled === true && delivery?.state === 'DONE';
      },
    );

    const requests = store.listPlanningRequests('P-real');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].id, 'initial-plan');
    assert.equal(requests[0].state, 'PLANNED');
    assert.equal(requests[1].request.purpose, 'PM_PLAN_REVISION');
    assert.equal(requests[1].state, 'PLANNED');

    const plannerTasks = store.listTasks('P-real').filter(task => task.scope === 'control');
    assert.ok(
      plannerTasks.some(task =>
        (task.history ?? []).some(entry => entry.type === 'ROLE_RESULT' && entry.role === 'tech_lead_critic' && entry.outcome === 'ISSUES')
      ),
      'first critic round must request repair',
    );
    assert.ok(
      plannerTasks.some(task =>
        (task.history ?? []).some(entry => entry.type === 'ROLE_RESULT' && entry.role === 'tech_lead_critic' && entry.outcome === 'CLEAN')
      ),
      'later critic round must accept repaired plan',
    );

    const delivery = store.getTask('project-impl');
    assert.equal(delivery.state, 'DONE');
    assert.deepEqual(
      delivery.history
        .filter(entry => entry.type === 'ROLE_RESULT')
        .map(entry => [entry.role, entry.outcome]),
      [
        ['developer', 'PASS'],
        ['developer', 'PASS'],
        ['tester', 'PASS'],
        ['reviewer', 'PASS'],
      ],
    );
    const sealFailures = delivery.history.filter(entry => entry.type === 'INTERFACE_SEAL_FAILED');
    assert.equal(sealFailures.length, 1);
    assert.deepEqual(sealFailures[0].failures, [{
      interfaceId: 'project-run',
      reason: 'MISSING_REALIZATION_BINDING',
    }]);
    assert.equal(
      fs.readFileSync(path.join(workspace, 'feature.js'), 'utf8'),
      "export const projectRun = () => 'implemented';\n",
    );
    const featureContract = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'planner', 'interfaces', 'features', 'project.json'), 'utf8'),
    );
    assert.equal(featureContract.bindings[0].interfaceId, 'project-run');
    assert.equal(featureContract.bindings[0].realizationAnchors[0].status, 'VALID');
    assert.equal(featureContract.bindings[0].realizationAnchors[0].symbol, 'projectRun');

    const pmRuns = providerHarness.invocations.filter(item => item.role === 'pm');
    const tlRuns = providerHarness.invocations.filter(item => item.role === 'tech_lead');
    assert.equal(pmRuns.length, 2);
    assert.ok(tlRuns.length >= 5, 'TL must cover feature frontier, milestone frontier, dependency compile, repair, and replan work');

    await piProvider.close();
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
