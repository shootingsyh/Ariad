import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { TECH_LEAD_PLAN_SCHEMA, validateTechLeadPlan } from './tech-lead-plan.js';
import { buildTechLeadPrompt } from './tech-lead-prompt.js';

function latestRoleResult(task) {
  const history = task?.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.type === 'ROLE_RESULT') return history[i];
  }
  return null;
}

function flowTasks(store, task) {
  return store.listTasks(task.projectId, { flowId: task.flowId });
}

function predecessorResults(store, task) {
  const byId = new Map(flowTasks(store, task).map(item => [item.id, item]));
  return (task.dependsOn ?? []).map(id => latestRoleResult(byId.get(id))).filter(Boolean);
}

function resolveArtifactResult(result, artifactRoot) {
  if (!result?.artifactRef || !artifactRoot) return result;
  const root = resolve(artifactRoot);
  const file = resolve(root, result.artifactRef);
  if (file !== root && !file.startsWith(root + sep)) throw new Error('artifactRef escapes Ariad artifact root');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function latestPlanInFlow(store, task, artifactRoot) {
  const tasks = flowTasks(store, task);
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const raw = latestRoleResult(tasks[i])?.result;
    const result = resolveArtifactResult(raw, artifactRoot);
    const candidate = result?.plan ?? result;
    if (candidate?.version === 2 && Array.isArray(candidate?.tasks)) return candidate;
  }
  return null;
}

function failureCount(task) {
  const history = task.history ?? [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type !== 'ROLE_RESULT') continue;
    if (entry.role === 'project_debugger' && entry.outcome === 'WRONG_IMPLEMENTATION_APPROACH') break;
    if ((entry.role === 'tester' || entry.role === 'reviewer') && entry.outcome === 'NOT_PASS') count += 1;
  }
  return count;
}

function strategyEpoch(task) {
  return 1 + (task.history ?? []).filter(
    entry => entry?.type === 'ROLE_RESULT'
      && entry.role === 'project_debugger'
      && entry.outcome === 'WRONG_IMPLEMENTATION_APPROACH'
  ).length;
}

function planningSkipIds(task, round) {
  const batchId = task.input?.planningBatchId;
  if (!batchId) return [];
  const id = name => `planner:${batchId}:${name}`;
  if (round === 1) return [
    id('repair-1'),
    id('validate-2'), id('critic-2'), id('repair-2'),
    id('validate-3'), id('critic-3'), id('repair-3'),
  ];
  if (round === 2) return [
    id('repair-2'),
    id('validate-3'), id('critic-3'), id('repair-3'),
  ];
  if (round === 3) return [id('repair-3')];
  return [];
}

function planningBatchRequests(store, task) {
  const batchId = task.input?.planningBatchId;
  if (!batchId) return [];
  return store.listPlanningRequests(task.projectId).filter(item => item.batchId === batchId);
}

function isTakeoverPlanningTask(store, task) {
  return planningBatchRequests(store, task).some(item => item.request?.purpose === 'RESTORE_PROJECT_STATE');
}

const DEVELOPER_REUSE_PROMPT = [
  "You are Ariad's developer role.",
  'Inspect task history before changing code.',
  'If TAKEOVER_NOTE or other prior context points to existing implementation, inspect and reuse/fix/extend it when sensible; do not rewrite merely because this task exists in the current plan.',
  'Historical completion is context only. Produce the current implementation required by the acceptance criteria.',
].join(' ');

const TESTER_REUSE_PROMPT = [
  "You are Ariad's tester role.",
  'Inspect task history and the existing test code before creating new tests.',
  'Reuse valid existing tests. Fix, extend, add, or remove tests only when needed to make them accurately cover the current acceptance criteria.',
  'All relevant verification must be freshly executed now and must produce fresh evidence; historical test passes are not evidence for this run.',
  'Map each acceptance criterion to actual verification, and do not treat the existence of a similarly named test as sufficient coverage.',
].join(' ');

const REVIEWER_FRESH_EVIDENCE_PROMPT = [
  "You are Ariad's reviewer role.",
  'Treat TAKEOVER_NOTE and all historical implementation/test/review claims as context only.',
  'Accept only on the basis of the current Tester run and its fresh evidence against the current acceptance criteria.',
].join(' ');

function plannerPrompt({ store, project, task, artifactRoot }) {
  const purpose = task.input?.purpose;
  const currentPlan = latestPlanInFlow(store, task, artifactRoot);
  const context = {
    project: {
      id: project.id,
      spec: project.spec ?? null,
      deliveryPlanSummary: project.deliveryPlanSummary ?? null,
    },
    planningRequests: task.input?.requests ?? [],
    currentDeliveryPlan: currentPlan,
  };

  if (purpose === 'PLANNER_DECOMPOSE') {
    return buildTechLeadPrompt({ projectContext: context, schema: TECH_LEAD_PLAN_SCHEMA });
  }

  if (purpose === 'PLANNER_DEPENDENCIES') {
    return [
      'You are Ariad\'s Tech Lead dependency pass.',
      'Take the supplied candidate plan, preserve its logical tree unless necessary, and return a complete corrected v2 plan.',
      'Add only precise cross-branch dependsOn edges. Never repeat parent-child ordering.',
      buildTechLeadPrompt({ projectContext: context, schema: TECH_LEAD_PLAN_SCHEMA }),
    ].join('\n\n');
  }

  if (purpose === 'PLANNER_REPAIR') {
    const previous = predecessorResults(store, task)[0]?.result ?? null;
    return [
      'You are Ariad\'s Tech Lead repair pass.',
      'Repair the latest candidate plan using the critic findings below. Return the complete corrected v2 plan.',
      'Do not add unrelated scope.',
      JSON.stringify({ context, critic: previous }, null, 2),
      'OUTPUT SCHEMA',
      JSON.stringify(TECH_LEAD_PLAN_SCHEMA, null, 2),
    ].join('\n\n');
  }

  return buildTechLeadPrompt({ projectContext: context, schema: TECH_LEAD_PLAN_SCHEMA });
}

function criticPrompt({ store, project, task, artifactRoot }) {
  const validation = predecessorResults(store, task)[0]?.result ?? null;
  return [
    'You are Ariad\'s delivery-plan critic.',
    'Review the candidate v2 delivery plan and validator result. Focus on missing dependencies, over-broad serialization, bad hierarchy, missing integration/E2E responsibility, and tasks that are too large.',
    'Return JSON only:',
    '{"executionStatus":"COMPLETED","outcome":"CLEAN|MINOR_ONLY|ISSUES","result":{"issues":[{"severity":"error|major|minor","message":"string"}],"summary":"string"}}',
    'On round 3, use MINOR_ONLY when only non-blocking polish remains.',
    JSON.stringify({
      project: { id: project.id, spec: project.spec ?? null },
      round: task.input?.round ?? null,
      validation,
      plan: validation?.plan ?? latestPlanInFlow(store, task, artifactRoot),
    }, null, 2),
  ].join('\n\n');
}

export function createDefaultV2Roles({
  store,
  providerId = 'openclaw-v2',
  codeProviderId = 'ariad-code',
  workspace,
  sourceControl = null,
  enqueuePlanning = null,
  artifactRoot = null,
}) {
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

  const plannerArtifact = task => {
    if (!artifactRoot) return null;
    const safe = String(task.id).replace(/[^a-zA-Z0-9._-]+/g, '-');
    return { ref: `planner/${safe}.json`, path: resolve(artifactRoot, 'planner', `${safe}.json`) };
  };

  const prepareLlm = (task, v2Prompt, extra = {}) => ({
    provider: providerId,
    workspace,
    context: {
      ...extra,
      v2Prompt,
      task: {
        id: task.id,
        title: task.title ?? null,
        intent: task.intent ?? task.input?.intent ?? null,
        acceptanceCriteria: task.acceptanceCriteria ?? task.input?.acceptanceCriteria ?? [],
        testStrategy: task.testStrategy ?? task.input?.testStrategy ?? null,
        history: task.history ?? [],
      },
      devCycle: 1 + failureCount(task),
      strategyEpoch: strategyEpoch(task),
    },
  });

  return {
    developer: {
      prepare: ({ task }) => prepareLlm(task, DEVELOPER_REUSE_PROMPT),
      transition: () => ({ stage: 'tester', state: 'READY' }),
    },

    tester: {
      prepare: ({ task }) => prepareLlm(task, TESTER_REUSE_PROMPT, {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
      }),
      transition: ({ task, result }) => {
        if (result.outcome === 'PASS') return { stage: 'reviewer', state: 'READY' };
        if (result.outcome === 'NOT_PASS') {
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        return { state: 'NEEDS_HUMAN' };
      },
    },

    reviewer: {
      prepare: ({ task }) => prepareLlm(task, REVIEWER_FRESH_EVIDENCE_PROMPT, {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
      }),
      transition({ task, result }) {
        if (result.outcome === 'NOT_PASS') {
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        if (result.outcome !== 'PASS') return { state: 'NEEDS_HUMAN' };
        return { state: 'DONE' };
      },
      async afterPersist({ task }) {
        if (!sourceControl || task.state !== 'DONE') return null;
        store.checkpoint?.();
        const finalized = await sourceControl.finalize({
          taskId: task.id,
          strategyEpoch: strategyEpoch(task),
          devCycle: Math.max(1, failureCount(task) + 1),
        });
        if (finalized.ok) return null;
        const sourceControlFailures = (task.history ?? []).filter(
          entry => entry?.type === 'SYSTEM_INTERRUPTION' && entry?.role === 'source_control'
        ).length;
        return {
          patch: {
            stage: 'reviewer',
            state: sourceControlFailures >= 2 ? 'SYSTEM_BLOCKED' : 'READY',
          },
          transitionHistory: {
            type: 'SYSTEM_INTERRUPTION',
            role: 'source_control',
            failure: finalized.failure ?? 'SOURCE_CONTROL_FAILED',
            at: new Date().toISOString(),
          },
        };
      },
    },

    project_debugger: {
      prepare: ({ task }) => prepareLlm(task, null),
      transition: ({ task, result }) => {
        if (result.outcome === 'WRONG_IMPLEMENTATION_APPROACH') {
          return strategyEpoch(task) >= 3
            ? { state: 'NEEDS_HUMAN' }
            : { stage: 'developer', state: 'READY' };
        }
        if (result.outcome === 'TASK_TOO_LARGE') {
          enqueuePlanning?.({
            request: {
              purpose: 'REPLAN_TASK',
              taskId: task.id,
              diagnosis: result.result ?? result,
            },
          });
          return { stage: 'developer', state: 'WAITING_REPLAN' };
        }
        return { state: 'NEEDS_HUMAN' };
      },
    },

    tech_lead: {
      prepare: ({ project, task }) => {
        const artifact = plannerArtifact(task);
        if (artifact) mkdirSync(resolve(artifactRoot, 'planner'), { recursive: true });
        const base = plannerPrompt({ store, project, task, artifactRoot });
        const prompt = artifact ? [
          base,
          '',
          'LARGE RESULT TRANSPORT',
          `Write the COMPLETE v2 plan JSON object to this exact file path using the file write tool: ${artifact.path}`,
          'Do not put the full plan in your final reply.',
          'After the file is successfully written, return ONLY this small JSON object:',
          JSON.stringify({
            executionStatus: 'COMPLETED',
            outcome: 'PLANNED',
            result: { artifactRef: artifact.ref, summary: 'v2 delivery plan written' },
          }),
        ].join('\n') : base;
        return prepareLlm(task, prompt);
      },
      transition: ({ task, result }) => {
        if (task.scope === 'control') return { state: 'DONE' };
        return result.outcome === 'PLANNED' || result.outcome === 'REPLANNED'
          ? { stage: 'developer', state: 'WAITING_REPLAN' }
          : { state: 'NEEDS_HUMAN' };
      },
    },

    tech_lead_critic: {
      prepare: ({ project, task }) => prepareLlm(task, criticPrompt({ store, project, task, artifactRoot })),
      transition: ({ task, result }) => {
        if (result.outcome === 'CLEAN' || result.outcome === 'MINOR_ONLY') {
          return {
            state: 'DONE',
            skipTaskIds: planningSkipIds(task, task.input?.round),
          };
        }
        return { state: 'DONE' };
      },
    },

    plan_validator: {
      prepare: ({ task }) => ({
        provider: codeProviderId,
        execute: async () => {
          const candidate = latestPlanInFlow(store, task, artifactRoot);
          if (!candidate) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, error: 'NO_CANDIDATE_PLAN', plan: null },
            };
          }
          try {
            const validated = validateTechLeadPlan(candidate);
            return {
              outcome: 'PASS',
              result: { valid: true, plan: validated.plan, error: null },
            };
          } catch (error) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, plan: candidate, error: error?.message ?? String(error) },
            };
          }
        },
      }),
      transition: ({ task, result }) => {
        if (task.input?.purpose === 'PLANNER_FINAL_VALIDATE' && result.outcome !== 'PASS') {
          return { state: 'NEEDS_HUMAN' };
        }
        return { state: 'DONE' };
      },
    },

    pm: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        const validation = predecessorResults(store, task)[0]?.result ?? null;
        const takeover = isTakeoverPlanningTask(store, task);
        const prompt = [
          'You are Ariad\'s PM reviewing a validated delivery plan against user intent.',
          takeover
            ? 'This is an existing-project takeover. Verify that the reconstruction is coherent, reuse-first, explains uncertainty, and is ready to show the human. Do not treat historical tests/reviews as current evidence. If the human has already supplied a HUMAN_DECISION in task history, incorporate it explicitly.'
            : null,
          'Return JSON only:',
          '{"executionStatus":"COMPLETED","outcome":"PLAN_ACCEPTED|PLAN_REVISION_REQUIRED|NEEDS_HUMAN","result":{"reason":"string","guidance":"string","questions":["string"]}}',
          JSON.stringify({
            project: { id: project.id, spec: project.spec ?? null },
            takeover,
            plan: validation?.plan ?? latestPlanInFlow(store, task, artifactRoot),
          }, null, 2),
        ].filter(Boolean).join('\n\n');
        return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
      },
      transition: ({ task, result }) => {
        if (result.outcome === 'PLAN_ACCEPTED') {
          const plan = latestPlanInFlow(store, task, artifactRoot);
          validateTechLeadPlan(plan);
          store.applyDeliveryPlan(task.projectId, plan);
          const takeover = isTakeoverPlanningTask(store, task);
          const hasHumanDecision = (task.history ?? []).some(entry => entry?.type === 'HUMAN_DECISION');
          if (takeover && !hasHumanDecision) {
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'TAKEOVER_REVIEW',
                role: 'pm',
                summary: result.result?.reason ?? 'Existing project reconstructed and ready for human takeover review.',
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          return { state: 'DONE' };
        }
        if (result.outcome === 'PLAN_REVISION_REQUIRED') {
          enqueuePlanning?.({
            request: {
              purpose: 'PM_PLAN_REVISION',
              guidance: result.result?.guidance ?? result.result ?? null,
            },
          });
          return { state: 'DONE' };
        }
        return { state: 'NEEDS_HUMAN' };
      },
    },
  };
}
