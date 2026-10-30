import { runAutomatedRegression } from '../runtime/automated-regression.js';
import { deriveExecutionHandoff } from '../runtime/role-run-prompt.js';
import { buildTaskContextArtifact, writeTaskContextArtifact } from '../runtime/task-context-artifact.js';
import { acceptanceCriterionIds } from './acceptance.js';
import { acceptInitialTaskTree } from './approved-task-tree.js';
import { artCapabilityRecommendations, requiredArtCapabilities } from './art-capabilities.js';
import { validatePlanAutonomy } from './autonomy.js';
import { TASK_KINDS, scopeOfTask } from './control-task-policy.js';
import { validateFeatureDecompositionIteration } from './feature-decomposition-validator.js';
import { finishFrontierPass, hasBoundaryContracts, loadBoundaryContracts, loadPlannerHierarchy, validateBoundaryContracts, validateTaskOwnershipCompilation } from './interface-contracts.js';
import { sealRoleInterfaces } from './interface-seal.js';
import { ensurePlannerArtifactLayout, loadFeatureTreeDiff, loadPlannerArtifactPlan, validatePlannerArtifactPlan } from './planner-artifacts.js';
import { buildRoleBoundaryContext } from './role-boundary-context.js';
import { roleExecutorBinding } from './role-executor-binding.js';
import { executorTransitionFromResult } from './role-executor-transition.js';
import { completeTakeoverReview } from './takeover-gate.js';
import { reconcileApprovedTaskTree } from './task-tree-reconciliation.js';
import { validateTechLeadPlan } from './tech-lead-plan.js';
import { loadPreparedUnifiedTaskTree, verifyUnifiedCompilerAgainstStore } from './unified-task-compiler.js';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PLAN_RESULT_TRANSITION = Symbol('planResultTransition');

import { pmEscalationHasQuestions, flowTasks, predecessorResults, latestLegacyPlanInFlow, latestPlanInFlow, failureCount, roleSealFailureCount, strategyEpoch, planningSkipIds, planningBatchRequests, isTakeoverPlanningTask, latestFrontierCompletion, iterationRequest, materializeIterationFeatureTree } from './planning-helpers.js';
import { ARTIST_PROMPT, CODE_NAVIGATION_PROMPT, DEVELOPER_REUSE_PROMPT, TESTER_REUSE_PROMPT, REVIEWER_FRESH_EVIDENCE_PROMPT, deliveryRoleSuffix, plannerPublicPlan, plannerPrompt, criticPrompt } from './role-prompts.js';
export function createDefaultV2Roles({
  store,
  providerId = 'pi-agent-session',
  completionProtocol = 'provider_terminal',
  codeProviderId = 'ariad-code',
  workspace,
  sourceControl = null,
  uxReviewEnabled = false,
  enqueuePlanning = null,
  reportIssue = null,
  insertTriagedFixTask = null,
  recoverLegacyIssueBlockedTask = null,
  requestPlanning = null,
  artifactRoot = null,
  executionCapabilities = [],
  executionProvenance = {},
  resolveRoleExecutionMetadata = null,
  codeIntelligence = null,
}) {
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

  const executionMetadataFor = (task) => (
    typeof resolveRoleExecutionMetadata === 'function'
      ? structuredClone(resolveRoleExecutionMetadata(task.stage) ?? {})
      : {}
  );

  const executionProvenanceFor = (task) => ({
    ...structuredClone(executionProvenance),
    ...executionMetadataFor(task),
  });

  const processDiscoveredIssues = (task, result) => {
    const declared = result?.result?.discoveredIssues ?? [];
    if (reportIssue && Array.isArray(declared)) {
      for (const issue of declared) {
        reportIssue({
          source: { kind: 'internal-role', ref: `${task.id}:${task.stage}` },
          sourceTaskId: task.id,
          reportedBy: task.stage,
          title: issue.title,
          description: issue.description,
          evidence: issue.evidence ?? [],
          severity: issue.severity ?? 'medium',
          blocking: issue.blocking === true,
          affectedComponent: issue.affectedComponent ?? null,
          affectedInterface: issue.affectedInterface ?? null,
          fingerprint: issue.dedupeKey ?? null,
          context: { roleOutcome: result.outcome, reportedAtRoleResult: true },
        });
      }
    }
    // Reporting an issue never changes the source task's acceptance outcome.
    // Only TL triage may establish cross-task or milestone dependencies.
    return null;
  };

  const specialistTransition = (task, result, current) => {
    if (result.outcome !== 'PASS') return { state: 'NEEDS_HUMAN', transitionHistory: {
      type: 'PLANNING_SPECIALIST_BLOCKED', specialist: current,
      reason: result.summary ?? null, at: new Date().toISOString(),
    } };
    const stages = task.input?.planningRoute?.stages ?? {};
    const order = ['feature', 'milestone', 'interface'];
    const roleNames = { feature: 'feature_planner', milestone: 'milestone_planner', interface: 'interface_architect' };
    const next = order.slice(order.indexOf(current) + 1).find(name => stages[name] === 'RUN');
    return next ? { stage: roleNames[next], state: 'READY' } : { state: 'DONE' };
  };

  const techLeadDeliveryTransition = (task, result) => {
        // PLANNING tasks are owned by the plan executor; this residue only
        // serves delivery-scope Tech Lead replan requests.
        if (result.outcome === 'PLANNED' || result.outcome === 'REPLANNED') {
          return { stage: 'developer', state: 'WAITING_REPLAN' };
        }
        throw new Error('TECH_LEAD_PLANNING_TASKS_ARE_EXECUTOR_OWNED');
  };

  const pmDeliveryTransition = (task, result) => {
          if (scopeOfTask(task) === 'delivery') {
            if (result.outcome === 'PRODUCT_DECISION') {
              const decision = result.result?.decision ?? result.result?.reason ?? result.summary ?? null;
              enqueuePlanning?.({
                request: {
                  purpose: 'PRODUCT_DECISION_REPLAN',
                  taskId: task.id,
                  decision,
                  guidance: result.result?.guidance ?? null,
                  instruction: 'Translate the PM product decision into the smallest correct engineering change. Amend the current task when local, replan the affected subtree when cross-task, or replan the project only when product scope truly requires it.',
                },
              });
              return {
                stage: 'developer',
                state: 'WAITING_REPLAN',
                transitionHistory: {
                  type: 'PRODUCT_DECISION',
                  role: 'pm',
                  decision,
                  guidance: result.result?.guidance ?? null,
                  at: new Date().toISOString(),
                },
              };
            }
            if (result.outcome === 'NEEDS_HUMAN' && pmEscalationHasQuestions(result)) {
              return {
                state: 'NEEDS_HUMAN',
                transitionHistory: {
                  type: 'PM_HUMAN_DECISION',
                  role: 'pm',
                  summary: result.summary ?? result.result?.reason ?? 'PM requires a new product decision from the user.',
                  questions: result.result?.questions ?? [],
                  guidance: result.result?.guidance ?? null,
                  at: new Date().toISOString(),
                },
              };
            }
            return {
              stage: 'pm',
              state: 'READY',
              transitionHistory: {
                type: 'PM_DECISION_RETRY',
                role: 'pm',
                summary: `Unexpected PM delivery-escalation outcome: ${result.outcome}`,
                at: new Date().toISOString(),
              },
            };
          }
        throw new Error('PM_PLANNING_TASKS_ARE_EXECUTOR_OWNED');
  };
  const planTransitionBodies = {
    tech_lead: ({ task, result }) => {
        if (task.input?.purpose === 'PLANNING_ROUTE') {
          if (result.outcome !== 'PLANNING_ROUTE') return { state: 'NEEDS_HUMAN' };
          const route = result.result;
          const next = ['feature', 'milestone', 'interface'].find(name => route.stages[name] === 'RUN');
          const roles = { feature: 'feature_planner', milestone: 'milestone_planner', interface: 'interface_architect' };
          return next ? { stage: roles[next], state: 'READY', input: { ...task.input, planningRoute: route } }
            : { state: 'DONE', input: { ...task.input, planningRoute: route } };
        }
        if (task.taskKind === 'ADHOC_ANALYSIS') {
          return {
            state: 'DONE',
            transitionHistory: {
              type: 'ADHOC_ANALYSIS_COMPLETED',
              role: 'tech_lead',
              outcome: result.outcome,
              findings: result.summary ?? result.result ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'PLANNED' || result.outcome === 'REPLANNED') {
          if (scopeOfTask(task) === 'control' && task.input?.purpose === 'PLANNER_DECOMPOSE') {
            const nodeType = task.input?.frontierPhase ?? 'feature';
            const pass = finishFrontierPass(artifactRoot, nodeType);
            const frontierHistory = {
              type: 'PLANNER_FRONTIER_LAYER_COMPLETE',
              role: 'tech_lead',
              nodeType,
              nodeId: pass.targetNodeId,
              disposition: pass.targetDisposition,
              childIds: pass.childIds,
              nextNodeId: pass.next?.node?.id ?? null,
              at: new Date().toISOString(),
            };
            if (task.input?.singleFrontier === true) {
              return {
                state: 'DONE',
                transitionHistory: frontierHistory,
              };
            }
            if (pass.next) {
              return {
                state: 'READY',
                input: {
                  ...task.input,
                  frontierPhase: nodeType,
                },
                transitionHistory: frontierHistory,
              };
            }
            if (nodeType === 'feature') {
              return {
                state: 'READY',
                input: {
                  ...task.input,
                  frontierPhase: 'milestone',
                },
                transitionHistory: {
                  type: 'PLANNER_FRONTIER_PHASE_COMPLETE',
                  role: 'tech_lead',
                  nodeType: 'feature',
                  nextPhase: 'milestone',
                  at: new Date().toISOString(),
                },
              };
            }
            return { state: 'DONE' };
          }
          return scopeOfTask(task) === 'control'
            ? { state: 'DONE' }
            : { stage: 'developer', state: 'WAITING_REPLAN' };
        }
        return {
          stage: 'pm',
          state: 'READY',
          transitionHistory: {
            type: 'TECH_LEAD_ESCALATED_TO_PM',
            role: 'tech_lead',
            summary: result.summary ?? result.result?.reason ?? 'Tech Lead requires a product-level decision before planning can continue.',
            guidance: result.result?.guidance ?? null,
            at: new Date().toISOString(),
          },
        };
    },
    tech_lead_critic: ({ task, result }) => {
        if (task.input?.purpose === 'PLANNING_ROUTE_CRITIC') {
          return ['CLEAN', 'MINOR_ONLY'].includes(result.outcome)
            ? { state: 'DONE' }
            : { state: 'NEEDS_HUMAN', transitionHistory: {
              type: 'PLANNING_ROUTE_CRITIC_FAILED', at: new Date().toISOString() } };
        }
        if (task.input?.purpose === 'PLANNER_FRONTIER_CRITIC') {
          const batchId = task.input?.planningBatchId;
          const round = task.input?.round ?? 1;
          if (result.outcome === 'CLEAN' || result.outcome === 'MINOR_ONLY') {
            const skipByRound = {
              1: [
                `planner:${batchId}:frontier-repair-1`,
                `planner:${batchId}:frontier-validate-2`,
                `planner:${batchId}:frontier-critic-2`,
                `planner:${batchId}:frontier-repair-2`,
                `planner:${batchId}:frontier-validate-3`,
                `planner:${batchId}:frontier-critic-3`,
                `planner:${batchId}:frontier-debugger`,
              ],
              2: [
                `planner:${batchId}:frontier-repair-2`,
                `planner:${batchId}:frontier-validate-3`,
                `planner:${batchId}:frontier-critic-3`,
                `planner:${batchId}:frontier-debugger`,
              ],
              3: [
                `planner:${batchId}:frontier-debugger`,
              ],
            };
            return {
              state: 'DONE',
              skipTaskIds: skipByRound[round] ?? [],
            };
          }
          return { state: 'DONE' };
        }
        if (result.outcome === 'CLEAN' || result.outcome === 'MINOR_ONLY') {
          return {
            state: 'DONE',
            skipTaskIds: planningSkipIds(task, task.input?.round),
          };
        }
        // Triage-only batches (issue disposition, no plan authorship): the
        // critic is advisory. Its findings are recorded on the task, but
        // they never open repair rounds - a triage batch must not turn into
        // plan-wide surgery. Strict validation and PM review still gate it.
        const batchRequests = typeof store?.listPlanningRequests === 'function'
          ? planningBatchRequests(store, task)
          : [];
        if (batchRequests.length > 0
          && batchRequests.every(item => item.request?.purpose === 'TRIAGE_AND_ASSIGN_ISSUE')) {
          return {
            state: 'DONE',
            skipTaskIds: planningSkipIds(task, task.input?.round),
            transitionHistory: {
              type: 'CRITIC_ADVISORY_ONLY',
              role: 'tech_lead_critic',
              summary: result.summary ?? result.result?.summary ?? 'Critic findings recorded as advisory for a triage-only batch.',
              issues: result.result?.issues ?? [],
              at: new Date().toISOString(),
            },
          };
        }
        return { state: 'DONE' };
    },
    plan_validator: ({ task, result }) => {
        if (task.input?.purpose === 'PLANNING_ROUTE_VALIDATE') {
          return result.outcome === 'PASS' ? { state: 'DONE' } : { state: 'NEEDS_HUMAN',
            transitionHistory: { type: 'PLANNING_ROUTE_VALIDATION_FAILED',
              reason: result.result?.error ?? 'Validation failed', at: new Date().toISOString() } };
        }
        if (task.input?.purpose === 'PLANNER_FINAL_VALIDATE' && result.outcome !== 'PASS') {
          if (result.result?.errorCode === 'INVALID_AUTONOMY_REQUIREMENT') {
            enqueuePlanning?.({
              request: {
                purpose: 'AUTONOMY_REPLAN',
                diagnosis: result.result,
                instruction: 'Replace required external/manual human work with an autonomous verification strategy. Do not weaken the acceptance requirement.',
              },
            });
            return { state: 'DONE' };
          }
          if (['ITERATION_LOGICAL_REVISION_REQUIRED', 'ITERATION_FEATURE_TREE_DIFF_REQUIRED'].includes(result.result?.errorCode)) {
            enqueuePlanning?.({
              request: {
                purpose: 'ITERATION_REVISION_REPLAN',
                diagnosis: result.result,
                instruction: 'Repair feature-tree-diff.json against the immutable previous-version snapshot/current durable logical tree. Use add/update/remove operations with stable ids; Ariad will deterministically materialize the next living feature tree. Do not hand-edit the generated logical tree as the authoritative change description.',
              },
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'tech_lead',
            state: 'READY',
            transitionHistory: {
              type: 'PLANNER_VALIDATION_ESCALATION',
              role: 'plan_validator',
              summary: result.result?.error ?? 'Planner validation failed after deterministic repair paths.',
              errorCode: result.result?.errorCode ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        return { state: 'DONE' };
    },
    pm: ({ task, result }) => {
        if (scopeOfTask(task) === 'delivery') {
          if (result.outcome === 'PRODUCT_DECISION') {
            const decision = result.result?.decision ?? result.result?.reason ?? result.summary ?? null;
            enqueuePlanning?.({
              request: {
                purpose: 'PRODUCT_DECISION_REPLAN',
                taskId: task.id,
                decision,
                guidance: result.result?.guidance ?? null,
                instruction: 'Translate the PM product decision into the smallest correct engineering change. Amend the current task when local, replan the affected subtree when cross-task, or replan the project only when product scope truly requires it.',
              },
            });
            return {
              stage: 'developer',
              state: 'WAITING_REPLAN',
              transitionHistory: {
                type: 'PRODUCT_DECISION',
                role: 'pm',
                decision,
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          if (result.outcome === 'NEEDS_HUMAN' && pmEscalationHasQuestions(result)) {
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'PM_HUMAN_DECISION',
                role: 'pm',
                summary: result.summary ?? result.result?.reason ?? 'PM requires a new product decision from the user.',
                questions: result.result?.questions ?? [],
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          return {
            stage: 'pm',
            state: 'READY',
            transitionHistory: {
              type: 'PM_DECISION_RETRY',
              role: 'pm',
              summary: `Unexpected PM delivery-escalation outcome: ${result.outcome}`,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'PLAN_ACCEPTED') {
          // A migrated unified tree must not pass through the legacy plan writer.
          // Verify the compiled view without mutating tasks, history, or delivery state.
          if (store.listTasks(task.projectId, { scope: 'delivery' }).some(t => t.unifiedTaskSchemaVersion === 1)) {
            const project = store.getProject(task.projectId);
            const compatibility = verifyUnifiedCompilerAgainstStore({artifactRoot,store,projectId:task.projectId});
            if (project?.unifiedTaskCompilerVersion === 1 && compatibility.ok) {
              // The migrated tree is already compiled and accepted. Re-accepting
              // it must not rewrite existing delivery state or enable scheduling.
              const loaded = loadPreparedUnifiedTaskTree({artifactRoot,store,projectId:task.projectId});
              return {state:'DONE',transitionHistory:{
                type:'UNIFIED_TASK_TREE_PLAN_ACCEPTED',role:'pm',
                summary:'Accepted existing prepared unified tree without rewriting tasks or enabling delivery.',
                taskCount:loaded.tasks.length,at:new Date().toISOString(),
              }};
            }
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'UNIFIED_TASK_TREE_PLAN_ACCEPTED_BLOCKED', role: 'pm',
                summary: compatibility.ok
                  ? 'Unified Task Tree verified; legacy PLAN_ACCEPTED writer is not supported. Delivery remains unchanged.'
                  : 'Unified Task Tree compiler/store mismatch; delivery remains unchanged.',
                compatibility, at: new Date().toISOString(),
              },
            };
          }
          // Preserve the one-time human takeover review.
          if (isTakeoverPlanningTask(store, task) && !(task.history ?? []).some(h => h?.type === 'HUMAN_DECISION')) {
            return { state: 'NEEDS_HUMAN', transitionHistory: {
              type: 'PM_HUMAN_DECISION', role: 'pm',
              summary: result.result?.reason ?? 'Review the reconstructed project before migrating legacy delivery state.',
              at: new Date().toISOString(),
            } };
          }
          const rawArtifactPlan = loadPlannerArtifactPlan(artifactRoot);
          if (!rawArtifactPlan) {
            // One flow, one plan format: PM approval consumes the planner
            // artifact plan. An inline tech-lead plan in flow history is a
            // planning input, never a tree source - there is no legacy
            // fallback and no migration gate behind this error.
            throw new Error('PM_PLAN_ARTIFACTS_MISSING: PM approval requires the planner artifact plan');
          }
          const validated = validatePlannerArtifactPlan(rawArtifactPlan);
          // Initial NEW project: persist the approved planner's tree nodes directly.
          // Never let a legacy replan rewrite an already approved Task Tree.
          const existingDelivery = store.listTasks(task.projectId, { scope: 'delivery' });
          if (existingDelivery.some(t => t.taskTreeSchemaVersion === 1)) {
            try {
              reconcileApprovedTaskTree(store, task.projectId, validated.plan, { artifactRoot });
            } catch (error) {
              return { state: 'NEEDS_HUMAN', transitionHistory: {
                type: 'TASK_TREE_REPLAN_BLOCKED', role: 'pm',
                summary: String(error?.message ?? error), at: new Date().toISOString(),
              } };
            }
          } else {
            // No legacy-format gate: a validated plan is accepted as the
            // project's tree, whatever flow produced it. If delivery tasks
            // already exist, acceptInitialTaskTree itself refuses
            // (APPROVED_TASK_TREE_EXISTING_TASKS) - a loud failure, never a
            // silent acceptance and never a human park.
            acceptInitialTaskTree(store, task.projectId, validated.plan, { artifactRoot });
          }
          // Canonical tree writes are complete; legacy plan writer is absent.
          const takeover = isTakeoverPlanningTask(store, task);
          const hasHumanDecision = (task.history ?? []).some(entry => entry?.type === 'HUMAN_DECISION');
          const setDeliveryEnabled = (enabled) => {
            const current = store.getProject(task.projectId);
            if (current?.deliveryEnabled === enabled) return current;
            return store.updateProject(task.projectId, current.version, { deliveryEnabled: enabled });
          };
          if (takeover && !hasHumanDecision) {
            setDeliveryEnabled(false);
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'PM_HUMAN_DECISION',
                role: 'pm',
                summary: result.result?.reason ?? 'Existing project reconstructed and ready for human takeover review.',
                guidance: result.result?.guidance ?? null,
                questions: result.result?.questions?.length
                  ? result.result.questions
                  : ['Approve the reconstructed current state and delivery plan, or provide corrections.'],
                at: new Date().toISOString(),
              },
            };
          }
          if (takeover && hasHumanDecision) completeTakeoverReview(store, task.projectId);
          setDeliveryEnabled(result.result?.startDelivery === true);
          return {
            state: 'DONE',
            transitionHistory: {
              type: 'DELIVERY_GATE',
              role: 'pm',
              enabled: result.result?.startDelivery === true,
              reason: result.result?.reason ?? null,
              at: new Date().toISOString(),
            },
          };
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
        if (result.outcome === 'NEEDS_HUMAN' && pmEscalationHasQuestions(result)) {
          return {
            state: 'NEEDS_HUMAN',
            transitionHistory: {
              type: 'PM_HUMAN_DECISION',
              role: 'pm',
              summary: result.summary ?? result.result?.reason ?? 'PM requires a new product decision from the user.',
              guidance: result.result?.guidance ?? null,
              questions: result.result?.questions ?? [],
              at: new Date().toISOString(),
            },
          };
        }
        return {
          stage: 'tech_lead',
          state: 'READY',
          transitionHistory: {
            type: 'PM_ESCALATED_TO_TECH_LEAD',
            role: 'pm',
            summary: result.summary ?? result.result?.reason ?? 'PM requires planning revision.',
            guidance: result.result?.guidance ?? null,
            at: new Date().toISOString(),
          },
        };
    },
    feature_planner: ({ task, result }) => specialistTransition(task, result, 'feature'),
    milestone_planner: ({ task, result }) => specialistTransition(task, result, 'milestone'),
    interface_architect: ({ task, result }) => specialistTransition(task, result, 'interface'),
  };

  const PLAN_SIGNALS = {
    PLAN: { 'DONE:': 'FINISH', 'READY:tech_lead': 'ADVANCE', 'READY:pm': 'ESCALATE', 'READY:feature_planner': 'ROUTE_FEATURE', 'READY:milestone_planner': 'ROUTE_MILESTONE', 'READY:interface_architect': 'ROUTE_INTERFACE', 'READY:project_debugger': 'ROUTE_DEBUG', 'NEEDS_HUMAN:': 'BLOCKED' },
    VALIDATE: { 'DONE:': 'FINISH', 'READY:tech_lead': 'ESCALATE', 'READY:project_debugger': 'ROUTE_DEBUG', 'NEEDS_HUMAN:': 'BLOCKED' },
    CRITIQUE: { 'DONE:': 'FINISH', 'READY:tech_lead': 'RETRY', 'READY:project_debugger': 'ROUTE_DEBUG', 'NEEDS_HUMAN:': 'BLOCKED' },
    PM_REVIEW: { 'DONE:': 'FINISH', 'READY:tech_lead': 'ESCALATE', 'READY:project_debugger': 'ROUTE_DEBUG', 'NEEDS_HUMAN:': 'BLOCKED' },
    FEATURE_PLAN: { 'READY:milestone_planner': 'ADVANCE_MILESTONE', 'READY:interface_architect': 'ADVANCE_INTERFACE', 'READY:tech_lead': 'RETRY', 'READY:project_debugger': 'ROUTE_DEBUG', 'DONE:': 'FINISH', 'NEEDS_HUMAN:': 'BLOCKED' },
    MILESTONE_PLAN: { 'READY:interface_architect': 'ADVANCE_INTERFACE', 'READY:tech_lead': 'RETRY', 'READY:project_debugger': 'ROUTE_DEBUG', 'DONE:': 'FINISH', 'NEEDS_HUMAN:': 'BLOCKED' },
    INTERFACE_PLAN: { 'DONE:': 'FINISH', 'READY:tech_lead': 'RETRY', 'READY:project_debugger': 'ROUTE_DEBUG', 'NEEDS_HUMAN:': 'BLOCKED' },
    DEBUG: { 'READY:tech_lead': 'REPAIRED', 'SYSTEM_BLOCKED:': 'NEEDS_HUMAN' },
  };

  planTransitionBodies.project_debugger = ({ task, result }) => {
    // Planning debugger, mirroring the sub-plan executor's semantics: one
    // guided recovery back to the tech lead; anything else is a terminal
    // diagnosis, which the executor maps to SYSTEM_BLOCKED (never a
    // per-task human decision).
    const guidance = result.result?.guidance;
    const repaired = result.outcome === 'RETRY_WITH_GUIDANCE'
      && typeof guidance === 'string' && Boolean(guidance.trim())
      && (task.input?.planDebuggerRecoveryCount ?? 0) < 1;
    if (repaired) {
      return {
        state: 'READY', stage: 'tech_lead',
        input: {
          ...(task.input ?? {}), planGateRetries: 0, planDebuggerRecoveryCount: 1,
          previousGateFailure: { ...(task.input?.previousGateFailure ?? {}), debuggerGuidance: guidance.trim() },
        },
        transitionHistory: { type: 'PLAN_DEBUGGER_RECOVERY', at: new Date().toISOString() },
      };
    }
    return {
      state: 'SYSTEM_BLOCKED',
      transitionHistory: {
        type: 'PLAN_DEBUGGER_DIAGNOSIS', outcome: result.outcome,
        guidance: guidance ?? result.summary ?? null, at: new Date().toISOString(),
      },
    };
  };

  // Write-side validation for planner artifacts. A planning session can
  // leave the on-disk contracts in a state the strict loaders reject -
  // the 2026-10-29 SRPG halt was a tech-lead triage note written into a
  // contract's featureTasks entry as a `history` key, which then threw
  // inside reconcile and parked the whole project FAILED. A planning
  // result is therefore never accepted while the artifacts fail their
  // own schema: the bounce below rides the existing gate ladder back to
  // the tech lead with the loader's message as feedback, so the writer
  // fixes its own write instead of poisoning the next reconcile. The PM
  // stage is excluded (its writes persist through the unified compiler,
  // which validates as it loads), as is the debugger (the ladder's
  // terminal fixer; bouncing it could loop it away from a diagnosis).
  // A bare JSON parse error does not say which artifact is broken, and a
  // bounced writer left hunting through dozens of files re-checks semantics
  // instead (the 2026-10-30 batch-48 halt: a missing comma in
  // milestones/V2.4.json stayed invisible through two retries and a debugger
  // pass). Name the unparseable planner artifacts in the guard's feedback.
  const unparseablePlannerArtifacts = () => {
    const bad = [];
    const walk = (dir) => {
      if (bad.length >= 5) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (bad.length >= 5) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          try { JSON.parse(readFileSync(full, 'utf8')); }
          catch { bad.push(full.slice(artifactRoot.length + 1)); }
        }
      }
    };
    walk(join(artifactRoot, 'planner'));
    return bad;
  };

  const plannerArtifactError = () => {
    if (!artifactRoot) return null;
    try {
      validateBoundaryContracts(artifactRoot, 'feature');
      validateBoundaryContracts(artifactRoot, 'milestone');
      loadPlannerArtifactPlan(artifactRoot);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const broken = unparseablePlannerArtifacts();
      return broken.length ? `${message} | unparseable planner artifacts: ${broken.join(', ')}` : message;
    }
  };

  const planResultTransition = (task, result) => {
    if (task.taskKind !== TASK_KINDS.PLANNING) return null;
    const body = planTransitionBodies[task.stage];
    if (!body) return null;
    let legacy = body({ task, result });
    if (!legacy) return null;
    if (task.stage !== 'pm' && task.stage !== 'project_debugger') {
      const artifactError = plannerArtifactError();
      if (artifactError) {
        legacy = {
          state: 'NEEDS_HUMAN',
          transitionHistory: {
            type: 'ARTIFACT_VALIDATION_FAILED',
            summary: artifactError,
            at: new Date().toISOString(),
          },
        };
      }
    }
    // Escalation whitelist: a planning-stage failure is machinery, not a
    // human decision. Bodies still report it as NEEDS_HUMAN; the bridge
    // converts it into the executor's recovery progression - back to the
    // tech lead twice, then to the project debugger, whose terminal
    // diagnosis lands in SYSTEM_BLOCKED. Deliberate human channels pass
    // through untouched: PM_HUMAN_DECISION (the PM's requirements call and
    // the takeover review) and the debugger's own terminal diagnosis.
    if (legacy.state === 'NEEDS_HUMAN' && task.stage !== 'project_debugger'
      && legacy.transitionHistory?.type !== 'PM_HUMAN_DECISION') {
      const retries = task.input?.planGateRetries ?? 0;
      const blockedType = legacy.transitionHistory?.type ?? null;
      const previousGateFailure = {
        stage: task.stage, blockedType,
        summary: legacy.transitionHistory?.summary ?? legacy.transitionHistory?.reason ?? null,
      };
      legacy = retries < 2
        ? {
          state: 'READY', stage: 'tech_lead',
          input: { ...(task.input ?? {}), planGateRetries: retries + 1, previousGateFailure },
          transitionHistory: { type: 'PLAN_GATE_RETRY', stage: task.stage, attempt: retries + 1, blockedType, summary: previousGateFailure.summary, at: new Date().toISOString() },
        }
        : {
          state: 'READY', stage: 'project_debugger',
          input: { ...(task.input ?? {}), previousGateFailure },
          transitionHistory: { type: 'PLAN_DEBUGGER_ROUTED', stage: task.stage, attempts: retries, blockedType, summary: previousGateFailure.summary, at: new Date().toISOString() },
        };
    }
    const { state, stage, ...extras } = legacy;
    const binding = roleExecutorBinding(task);
    if (!binding) throw new Error(`PLAN_EXECUTOR_BINDING_MISSING:${task.id}`);
    let signal = PLAN_SIGNALS[binding.state]?.[`${state}:${stage ?? (state === 'READY' ? task.stage : '')}`];
    // The PM's deliberate human gate (requirements call / takeover review)
    // exits the executor through its own terminal, not the failure path.
    if (legacy.transitionHistory?.type === 'PM_HUMAN_DECISION') signal = 'HUMAN_GATE';
    if (!signal) throw new Error(`PLAN_EXECUTOR_UNMAPPED_MOVE:${binding.state}/${state}:${stage ?? ''}`);
    const resolved = executorTransitionFromResult(task, signal);
    if (!resolved) throw new Error(`PLAN_EXECUTOR_BINDING_MISSING:${task.id}`);
    if (resolved.patch.state !== state) throw new Error(`PLAN_EXECUTOR_STATE_MISMATCH:${task.id}`);
    if (stage && resolved.patch.stage !== stage) throw new Error(`PLAN_EXECUTOR_STAGE_MISMATCH:${task.id}`);
    return { ...resolved.patch, ...extras };
  };

  const prepareLlm = (task, v2Prompt, extra = {}) => {
    const executionMetadata = executionMetadataFor(task);
    const sharedDeliveryContext = ['developer', 'test_engineer', 'tester', 'reviewer'].includes(task.stage);
    const roleBoundaryContext = buildRoleBoundaryContext({
      artifactRoot,
      task,
      role: sharedDeliveryContext ? 'delivery' : task.stage,
      workspace,
    });
    const taskArtifact = sharedDeliveryContext
      ? buildTaskContextArtifact({ task, boundaryContext: roleBoundaryContext, artifactRoot })
      : null;
    const taskArtifactPath = taskArtifact ? writeTaskContextArtifact(artifactRoot, taskArtifact) : null;
    const persistentSessionKey = ['pm', 'tech_lead', 'project_debugger'].includes(task.stage)
      ? `${task.stage}:${task.projectId}`
      : null;
    const modelRef = typeof executionMetadata.modelRef === 'string'
      ? executionMetadata.modelRef.trim()
      : '';
    return {
      provider: providerId,
      completionProtocol,
      resources: modelRef.startsWith('llamacpp/') ? ['local-llm'] : [],
      executionCapabilities: [...executionCapabilities],
      executionProvenance: {
        ...structuredClone(executionProvenance),
        ...executionMetadata,
      },
      workspace,
      ...(task.stage === 'tech_lead' && insertTriagedFixTask ? { insertTriagedFixTask } : {}),
      ...(task.stage === 'tech_lead' && recoverLegacyIssueBlockedTask ? { recoverLegacyIssueBlockedTask } : {}),
      ...(task.stage === 'tech_lead' && requestPlanning ? { requestPlanning } : {}),
      ...(sharedDeliveryContext && reportIssue ? {
        reportIssue: issue => reportIssue(issue),
      } : {}),
      context: {
        role: task.stage,
        executionCapabilities: [...executionCapabilities],
        ...(modelRef ? {
          roleModelRef: modelRef,
          roleModels: { [task.stage]: modelRef },
        } : {}),
        ...(persistentSessionKey ? { sessionKey: persistentSessionKey } : {}),
        ...extra,
        ...(sharedDeliveryContext ? {
          taskArtifact,
          taskArtifactPath,
          roleProtocol: v2Prompt,
        } : {}),
        ...(!sharedDeliveryContext && roleBoundaryContext ? { roleBoundaryContext } : {}),
        v2Prompt: sharedDeliveryContext ? '' : v2Prompt,
        task: {
          id: task.id,
          title: task.title ?? null,
          intent: task.intent ?? task.input?.intent ?? null,
          acceptanceCriteria: task.acceptanceCriteria ?? task.input?.acceptanceCriteria ?? [],
          acceptanceCriterionIds: acceptanceCriterionIds(task),
          verification: task.verification ?? task.input?.verification ?? [],
          testStrategy: task.testStrategy ?? task.input?.testStrategy ?? null,
          art: task.art ?? task.input?.art ?? null,
          history: task.history ?? [],
        },
        executionHandoff: deriveExecutionHandoff(task.history ?? []),
        devCycle: 1 + failureCount(task),
        strategyEpoch: strategyEpoch(task),
      },
    };
  };

  const sealAfterPersist = async (role, task, result) => {
    const seal = await sealRoleInterfaces({
      role,
      artifactRoot,
      workspace,
      task,
      result,
      codeIntelligence,
    });
    if (!seal.required) return null;
    if (!seal.ok) {
      const repairRole = seal.repairRole ?? role;
      const priorFailures = roleSealFailureCount(task, role);
      const exhaustedRepairBudget = priorFailures >= 3;
      return {
        patch: {
          stage: exhaustedRepairBudget ? 'project_debugger' : repairRole,
          state: 'READY',
          execution: null,
        },
        transitionHistory: {
          type: 'ROLE_SEAL_FAILED',
          role: 'interface_seal',
          ownerRole: role,
          repairRole,
          featureId: seal.featureId ?? null,
          failures: seal.failures ?? [],
          repairAttempt: Math.max(0, priorFailures),
          repairBudget: 3,
          ...(exhaustedRepairBudget ? { escalatedTo: 'project_debugger' } : {}),
          at: new Date().toISOString(),
        },
      };
    }
    return {
      transitionHistory: {
        type: 'ROLE_SEALED',
        role: 'interface_seal',
        ownerRole: role,
        featureId: seal.featureId ?? null,
        sealed: seal.sealed ?? [],
        observedCommit: seal.observedCommit ?? null,
        at: new Date().toISOString(),
      },
    };
  };

  const roleDefinitions = {
    artist: {
      prepare: ({ task }) => {
        const art = task.art ?? task.input?.art ?? null;
        const capabilities = requiredArtCapabilities(art ?? { required: true, media: [] });
        return prepareLlm(task, ARTIST_PROMPT, {
          art,
          capabilityRequirements: capabilities,
          capabilityRecommendations: artCapabilityRecommendations(capabilities),
        });
      },
      transition: ({ result }) => {
        if (result.outcome === 'PASS') return { stage: 'developer', state: 'READY' };
        return {
          stage: 'project_debugger',
          state: 'READY',
          transitionHistory: {
            type: result.outcome === 'NEEDS_CAPABILITY' ? 'CAPABILITY_REQUIRED' : 'ARTIST_REPAIR_FAILED',
            role: 'artist',
            summary: result.summary ?? 'Artist could not complete the required repair.',
            ...(result.outcome === 'NEEDS_CAPABILITY'
              ? {
                  missingCapabilities: result.result?.missingCapabilities ?? [],
                  recommendations: result.result?.recommendations ?? [],
                }
              : {}),
            at: new Date().toISOString(),
          },
        };
      },
    },

    developer: {
      prepare: ({ task }) => prepareLlm(task, [
        DEVELOPER_REUSE_PROMPT,
        CODE_NAVIGATION_PROMPT,
        deliveryRoleSuffix('developer'),
      ].join('\n\n')),
      transition: () => ({ stage: 'test_engineer', state: 'READY' }),
      async afterPersist({ task, result }) {
        const issueFollowUp = processDiscoveredIssues(task, result);
        if (issueFollowUp) return issueFollowUp;
        const sealFollowUp = await sealAfterPersist('developer', task, result);
        if (!sealFollowUp?.patch && result.outcome === 'PASS') {
          runAutomatedRegression({ workspace, artifactRoot, task, developerResult: result });
        }
        return sealFollowUp;
      },
    },

    test_engineer: {
      prepare: ({ task }) => prepareLlm(task, [CODE_NAVIGATION_PROMPT, deliveryRoleSuffix('test_engineer')].join('\n\n')),
      transition: ({ task, result }) => {
        if (result.outcome !== 'PASS') return failureCount(task) >= 3
          ? { stage: 'project_debugger', state: 'READY' }
          : { stage: 'developer', state: 'READY' };
        const plan = result.result?.testPlan;
        const criteria = acceptanceCriterionIds(task);
        const cases = plan?.testCases;
        const valid = Array.isArray(cases) && cases.length > 0
          && cases.every(c => c && typeof c.entry === 'string' && c.entry.length > 0
            && typeof c.command === 'string' && c.command.length > 0
            && Array.isArray(c.covers) && Array.isArray(c.executionScope))
          && criteria.every(id => cases.some(c => c.covers.includes(id)));
        if (!valid) return { stage: 'project_debugger', state: 'READY' };
        return { stage: 'tester', state: 'READY' };
      },
      async afterPersist({ task, result }) {
        return processDiscoveredIssues(task, result);
      },
    },

    tester: {
      prepare: ({ task }) => {
        const approved = [...(task.history ?? [])].reverse().find(h => h.type === 'ROLE_RESULT' && h.role === 'test_engineer' && h.outcome === 'PASS');
        if (!approved?.result?.testPlan?.testCases?.length) throw new Error('TEST_PLAN_MISSING: tester cannot start without Test Engineer plan');
        return prepareLlm(task, [
        TESTER_REUSE_PROMPT,
        deliveryRoleSuffix('tester'),
      ].join('\n\n'), {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
        approvedTestPlan: approved.result.testPlan,
      });
      },
      transition: ({ task, result }) => {
        if (result.outcome === 'PASS') return { stage: 'reviewer', state: 'READY' };
        if (result.outcome === 'NOT_PASS') {
          if (result.result?.testPlanInvalid === true) return { stage: 'test_engineer', state: 'READY' };
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        return { stage: 'project_debugger', state: 'READY' };
      },
      async afterPersist({ task, result }) {
        const issueFollowUp = processDiscoveredIssues(task, result);
        if (issueFollowUp) return issueFollowUp;
        return sealAfterPersist('tester', task, result);
      },
    },

    // Dormant unless a project opts into UX review AND a task explicitly requires it.
    ux_reviewer: {
      prepare: ({ task }) => prepareLlm(task, [
        'You are the independent UX reviewer. Evaluate only the task UX acceptance criteria against real rendered UI evidence (screenshots/video), interaction flows, accessibility and visual consistency.',
        'Do not infer visual PASS from source code alone. Return NOT_PASS with specific missing evidence or defects when UX cannot be verified.',
        'Do not modify implementation or project plans. Return PASS or NOT_PASS through the structured role-result tool.',
        deliveryRoleSuffix('ux_reviewer'),
      ].join('\n\n'), {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
      }),
      transition: ({ task, result }) => {
        if (result.outcome === 'PASS') return { state: 'DONE' };
        return failureCount(task) >= 3
          ? { stage: 'project_debugger', state: 'READY' }
          : { stage: 'developer', state: 'READY' };
      },
      async afterPersist({ task, result }) {
        const issueFollowUp = processDiscoveredIssues(task, result);
        if (issueFollowUp) return issueFollowUp;
        if (!sourceControl || task.state !== 'DONE' || result.outcome !== 'PASS') return null;
        store.checkpoint?.();
        const finalized = await sourceControl.finalize({
          taskId: task.id, strategyEpoch: strategyEpoch(task),
          devCycle: Math.max(1, failureCount(task) + 1),
        });
        if (finalized.ok) return null;
        return { patch: { stage: 'ux_reviewer', state: 'READY' }, transitionHistory: {
          type: 'SYSTEM_INTERRUPTION', role: 'source_control',
          failure: finalized.failure ?? 'SOURCE_CONTROL_FAILED', at: new Date().toISOString(),
        } };
      },
    },

    reviewer: {
      uxReviewEnabled,
      prepare: ({ task }) => prepareLlm(task, [
        REVIEWER_FRESH_EVIDENCE_PROMPT,
        deliveryRoleSuffix('reviewer'),
      ].join('\n\n'), {
        evidenceArtifactRoot: artifactRoot ? resolve(artifactRoot, 'tester') : null,
      }),
      transition({ task, result }) {
        if (result.outcome === 'NOT_PASS') {
          return failureCount(task) >= 3
            ? { stage: 'project_debugger', state: 'READY' }
            : { stage: 'developer', state: 'READY' };
        }
        if (result.outcome !== 'PASS') return { stage: 'project_debugger', state: 'READY' };
        if (uxReviewEnabled && task.ux?.required === true) return { stage: 'ux_reviewer', state: 'READY' };
        return { state: 'DONE' };
      },
      async afterPersist({ task, result }) {
        const issueFollowUp = processDiscoveredIssues(task, result);
        if (issueFollowUp) return issueFollowUp;
        const sealFollowUp = await sealAfterPersist('reviewer', task, result);
        if (sealFollowUp) {
          if (sealFollowUp.patch) return sealFollowUp;
          if (!sourceControl || task.state !== 'DONE') return sealFollowUp;
        }
        if (!sourceControl || task.state !== 'DONE') return sealFollowUp;
        store.checkpoint?.();
        const finalized = await sourceControl.finalize({
          taskId: task.id,
          strategyEpoch: strategyEpoch(task),
          devCycle: Math.max(1, failureCount(task) + 1),
        });
        if (finalized.ok) return sealFollowUp;
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
      sessionPolicy: 'persistent',
      prepare: ({ task }) => {
        if (task.input?.purpose === 'NODE_PLANNING_WORKFLOW') return prepareLlm(task, ['Diagnose this node planning failure without changing artifacts.', 'Phase:', task.input.phase, 'Node:', task.input.nodeId, 'Failure:', JSON.stringify(task.input.previousGateFailure), 'Distinguish artifact, requirement, and model failures. If a bounded repair is viable, return RETRY_WITH_GUIDANCE and a concrete result.guidance string. Otherwise submit a structured diagnosis; never override validator or critic.'].join('\n'));
        return prepareLlm(task, task.input?.blockedTaskId ? [
          "You are Ariad's unified Project Debugger.",
          'Automatic execution retry has been exhausted for the blocked business task below.',
          'Diagnose the root cause across BOTH project/task causes and execution/runtime/model causes.',
          'A runtime symptom does not imply a runtime root cause. If task size/shape likely caused repeated stalls, use TASK_TOO_LARGE so Tech Lead can split/replan it.',
          'Do not repair files, config, services, processes, task state, or model selection yourself. Return one routing diagnosis.',
          JSON.stringify(task.input?.systemIncident ?? {}, null, 2),
        ].join('\n\n') : task.input?.previousGateFailure ? [
          "You are Ariad's Project Debugger for a planning gate failure.",
          'The artifact write-path guard rejected a planning result and two tech-lead retries did not fix it.',
          'Gate failure:', JSON.stringify(task.input.previousGateFailure, null, 2),
          'Treat the named artifacts as the prime suspect: re-read and re-parse them yourself before judging plan semantics - a semantics-only check misses defects like malformed JSON.',
          'If a bounded artifact repair is viable, return RETRY_WITH_GUIDANCE with guidance naming the exact file and fix. Otherwise submit a structured diagnosis; never override validator or critic.',
        ].join('\n') : null);
      },
      transition: ({ task, result }) => {
        if (task.taskKind === TASK_KINDS.PLANNING) return planResultTransition(task, result);
        const blockedTaskId = task.input?.blockedTaskId ?? null;
        const blocked = blockedTaskId ? store.getTask(blockedTaskId) : null;
        const routeBlocked = (patch, history) => {
          if (!blocked) return;
          store.appendTaskHistory(blocked.id, blocked.version, history, patch);
        };

        if (result.outcome === 'WRONG_IMPLEMENTATION_APPROACH') {
          if (blocked) {
            routeBlocked({ stage: 'developer', state: 'READY', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'developer',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'developer',
            state: 'READY',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'developer',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'ASSET_ISSUE') {
          if (blocked) {
            routeBlocked({ stage: 'artist', state: 'READY', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'artist',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'artist',
            state: 'READY',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'artist',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'TASK_TOO_LARGE') {
          const targetTaskId = blockedTaskId ?? task.id;
          enqueuePlanning?.({
            request: {
              purpose: 'REPLAN_TASK',
              taskId: targetTaskId,
              diagnosis: result.result ?? result,
            },
          });
          if (blocked) {
            routeBlocked({ stage: 'developer', state: 'WAITING_REPLAN', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'tech_lead',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'developer',
            state: 'WAITING_REPLAN',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'tech_lead',
              diagnosis: result.outcome,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'SYSTEM_RUNTIME_FAILURE' || result.outcome === 'MODEL_CAPABILITY_MISMATCH') {
          return {
            state: 'NEEDS_HUMAN',
            transitionHistory: {
              type: 'SYSTEM_DIAGNOSIS',
              role: 'project_debugger',
              blockedTaskId,
              diagnosis: result.outcome,
              summary: result.summary ?? result.result?.reason ?? 'Execution failure requires operator action.',
              evidence: result.result?.evidence ?? [],
              affectedComponent: result.result?.affectedComponent ?? null,
              guidance: result.result?.guidance ?? null,
              questions: ['Review the diagnosis, repair the runtime/model policy as appropriate, then explicitly resume the project.'],
              at: new Date().toISOString(),
            },
          };
        }
        if (result.outcome === 'REQUIREMENT_DECISION_REQUIRED' || result.outcome === 'UNKNOWN_PROJECT_CAUSE') {
          if (blocked) {
            routeBlocked({ stage: 'pm', state: 'READY', execution: null }, {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'pm',
              diagnosis: result.outcome,
              summary: result.summary ?? result.result?.reason ?? null,
              guidance: result.result?.guidance ?? null,
              source: 'system_block_diagnosis',
              at: new Date().toISOString(),
            });
            return { state: 'DONE' };
          }
          return {
            stage: 'pm',
            state: 'READY',
            transitionHistory: {
              type: 'DEBUGGER_ROUTE',
              role: 'project_debugger',
              route: 'pm',
              diagnosis: result.outcome,
              summary: result.summary ?? result.result?.reason ?? null,
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            },
          };
        }
        return {
          stage: 'pm',
          state: 'READY',
          transitionHistory: {
            type: 'DEBUGGER_ROUTE',
            role: 'project_debugger',
            route: 'pm',
            diagnosis: result.outcome ?? 'UNKNOWN',
            summary: result.summary ?? null,
            at: new Date().toISOString(),
          },
        };
      },
    },

    feature_planner: {
      prepare: ({ task }) => prepareLlm(task, [
        'You are the Feature Planner. Work only on product feature semantics, feature hierarchy, and acceptance intent.',
        'Do not define interface IDs, imports, exports, anchors, or implementation contracts.',
        'Use the approved planning route and existing project artifacts. Preserve unchanged semantics.',
        'Planning route:', JSON.stringify(task.input?.planningRoute ?? {}),
        'Submit outcome PASS through ariad_role_result with a summary of semantic changes and artifacts.',
      ].join('\n')),
      transition: ({ task, result }) => planResultTransition(task, result),
    },
    milestone_planner: {
      prepare: ({ task }) => prepareLlm(task, [
        'You are the Milestone Planner. Work only on delivery semantics, milestone hierarchy, scenarios, and task intent/dependencies.',
        'Do not define interface IDs, imports, exports, anchors, or implementation contracts.',
        'Use the approved planning route and existing project artifacts. Preserve unchanged semantics.',
        'Planning route:', JSON.stringify(task.input?.planningRoute ?? {}),
        'Submit outcome PASS through ariad_role_result with a summary of semantic changes and artifacts.',
      ].join('\n')),
      transition: ({ task, result }) => planResultTransition(task, result),
    },
    interface_architect: {
      prepare: ({ task }) => prepareLlm(task, [
        'You are the Interface Architect. Translate existing Feature and Milestone semantics into strict interface contracts and exact task interface bindings.',
        'Process child Feature nodes before parents, then resolve Milestone interface dependencies. Do not alter product or delivery semantics.',
        'If upstream semantics are insufficient, report NOT_PASS with a concrete upstream revision request. Never invent product behavior.',
        'Planning route:', JSON.stringify(task.input?.planningRoute ?? {}),
        'Existing interface artifact layout:', String(artifactRoot ?? ''),
        'Submit outcome PASS or NOT_PASS through ariad_role_result with evidence and changed artifact paths.',
      ].join('\n')),
      transition: ({ task, result }) => planResultTransition(task, result),
    },

    tech_lead: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        if (task.input?.purpose === 'NODE_PLANNING_WORKFLOW') {
          return prepareLlm(task, [
            'You are the node-level Tech Lead. Work ONLY on the specified planning node.',
            'Phase:', task.input.phase, 'Node:', task.input.nodeId,
            'Planning context:', JSON.stringify(task.input.planningContext),
            'Previous validation failure:', JSON.stringify(task.input.previousGateFailure ?? null),
            'Do not change ancestors or sibling nodes. Apply direct-child-only changes and preserve existing unrelated semantics.',
            'Before PLANNED, materialize the current node in the feature/milestone logical tree with the exact id, parentId and planningContext.current.nodeType. Ensure its boundary contract has the same nodeType; do not guess.',
            'Return PLANNED through ariad_role_result only after saving verifiable artifacts.',
          ].join('\n'), { sessionKey: `workflow:${task.id}:planner` });
        }
        if (task.input?.purpose === 'PLANNING_ROUTE') {
          return prepareLlm(task, [
            'You are the Overall Tech Lead. Triage the request and choose a controlled planning route.',
            'Do not edit Feature, Milestone, Interface or delivery artifacts yourself.',
            'Use ariad_role_result with outcome PLANNING_ROUTE and a strict result containing requestType, reason, scope, stages and constraints.',
            'Stage order is feature -> milestone -> interface. RUN only affected stages, SKIP unchanged stages.',
            'Planning requests:', JSON.stringify(task.input.requests ?? []),
          ].join('\n'));
        }
        if (task.taskKind === 'ADHOC_ANALYSIS') {
          const prompt = [
            'You are the Ariad Tech Lead carrying out an isolated ad-hoc analysis.',
            'Read and investigate the repository as needed. Do not modify any files, planning artifacts, task graph, or implementation.',
            'Do not initiate Delivery, Replan, or task creation. For an explicitly operator-requested one-off recovery of a legacy issue-induced WAITING_REPLAN task, you MAY use ariad_recover_legacy_issue_task after verifying its provenance. Do not recover genuine Debugger/Replan tasks. Otherwise return findings only.',
            'Request:', task.input.instruction,
            'Context:', JSON.stringify(task.input.context ?? {}),
            'Return outcome PLANNED with your findings through the structured role-result tool.',
          ].join('\n');
          return prepareLlm(task, prompt, { sessionKey: 'adhoc:' + task.projectId + ':' + task.id });
        }
        if (artifactRoot) ensurePlannerArtifactLayout(artifactRoot);
        const prompt = [
          plannerPrompt({ store, project, task, artifactRoot }),
          ...(task.input?.previousGateFailure ? [
            '',
            'PREVIOUS GATE FAILURE',
            'Your previous result was rejected by the artifact write-path guard. Fix exactly this first, and verify the fix by re-parsing the named artifacts before resubmitting:',
            JSON.stringify(task.input.previousGateFailure, null, 2),
          ] : []),
          '',
          'FINAL RESULT',
          'After completing all required file writes, submit outcome PLANNED through the provider structured role-result mechanism when available; terminal JSON is not accepted as a result.',
        ].join('\n');
        return prepareLlm(task, prompt);
      },
      transition: ({ task, result }) => planResultTransition(task, result) ?? techLeadDeliveryTransition(task, result),
    },

    tech_lead_critic: {
      prepare: ({ project, task }) => prepareLlm(task,
        task.input?.purpose === 'NODE_PLANNING_WORKFLOW'
          ? ['Review the node planning artifacts without editing them.', 'Phase:', task.input.phase, 'Node:', task.input.nodeId, 'Scope:', JSON.stringify(task.input.planningContext), 'Reject missing evidence, invalid direct-child changes, or broken cross-node contracts. Return CLEAN, MINOR_ONLY, or ISSUES via ariad_role_result.'].join('\n')
          : task.input?.purpose === 'PLANNING_ROUTE_CRITIC'
          ? ['Review the completed controlled planning route and current artifacts.',
             'Verify no unrequested semantic changes and that interface bindings are precise.',
             'Do not modify artifacts. Return CLEAN, MINOR_ONLY, or ISSUES via ariad_role_result.',
             'Route result:', JSON.stringify(flowTasks(store, task).find(t => t.input?.purpose === 'PLANNING_ROUTE')?.input?.planningRoute ?? {})].join('\n')
          : criticPrompt({ store, project, task, artifactRoot })),
      transition: ({ task, result }) => planResultTransition(task, result),
    },

    plan_validator: {
      prepare: ({ task }) => ({
        provider: codeProviderId,
        executionProvenance: executionProvenanceFor(task),
        execute: async () => {
          if (task.input?.purpose === 'NODE_PLANNING_WORKFLOW') {
            try {
              if (!artifactRoot) throw new Error('WORKFLOW_ARTIFACT_ROOT_MISSING');
              const isGlobal = task.taskKind === 'GLOBAL_REVIEW';
              const phase = task.input.phase;
              if (!['feature', 'milestone', 'interface'].includes(phase)) throw new Error('WORKFLOW_PHASE_UNSUPPORTED');
              const declaredType = task.input.nodes?.find(node => node.id === task.input.nodeId)?.nodeType;
              const matchingTypes = (phase === 'interface' ? ['feature', 'milestone'] : [phase])
                .filter(type => loadPlannerHierarchy(artifactRoot, type).byId.has(task.input.nodeId));
              const nodeType = declaredType ?? (phase !== 'interface' ? phase : matchingTypes.length === 1 ? matchingTypes[0] : null);
              if (!nodeType || (phase === 'interface' && !matchingTypes.includes(nodeType))) throw new Error('WORKFLOW_NODE_TYPE_AMBIGUOUS_OR_MISSING');
              const hierarchy = loadPlannerHierarchy(artifactRoot, nodeType);
              const target = hierarchy.byId.get(task.input.nodeId);
              if (!target) throw new Error(`WORKFLOW_NODE_MISSING: ${task.input.nodeId}`);
              const expected = task.input.nodes?.find(node => node.id === task.input.nodeId);
              if (!expected || (target.parentId ?? null) !== (expected.parentId ?? null)) {
                throw new Error(`WORKFLOW_NODE_SCOPE_MISMATCH: ${task.input.nodeId}`);
              }
              const contracts = loadBoundaryContracts(artifactRoot, nodeType);
              if (!contracts.has(task.input.nodeId)) throw new Error(`WORKFLOW_CONTRACT_MISSING: ${task.input.nodeId}`);
              const validation = validateBoundaryContracts(artifactRoot, nodeType, { allowFrontier: !isGlobal, ...(!isGlobal ? { targetNodeId: task.input.nodeId } : {}) });
              if (isGlobal && phase === 'interface') {
                for (const type of ['feature', 'milestone']) {
                  const tree = loadPlannerHierarchy(artifactRoot, type);
                  if (tree.items.length) validateBoundaryContracts(artifactRoot, type, { allowFrontier: false });
                }
              }
              if (!validation.ok || validation.count === 0 || (isGlobal && !validation.complete)) {
                throw new Error('WORKFLOW_BOUNDARY_INCOMPLETE');
              }
              return { outcome: 'PASS', result: { nodeId: task.input.nodeId, validated: true, global: isGlobal } };
            } catch (error) {
              return { outcome: 'NOT_PASS', result: { nodeId: task.input.nodeId, error: error.message } };
            }
          }
          if (task.input?.purpose === 'PLANNING_ROUTE_VALIDATE') {
            const routeTask = flowTasks(store, task).find(t => t.input?.purpose === 'PLANNING_ROUTE');
            const route = routeTask?.input?.planningRoute;
            if (!route) return { outcome: 'NOT_PASS', result: { error: 'MISSING_PLANNING_ROUTE' } };
            try {
              if (route.stages.interface === 'RUN') {
                validateBoundaryContracts(artifactRoot, 'feature', { allowFrontier: false });
                validateBoundaryContracts(artifactRoot, 'milestone', { allowFrontier: false });
              }
              return { outcome: 'PASS', result: { valid: true, route } };
            } catch (error) {
              return { outcome: 'NOT_PASS', result: { valid: false, error: error.message } };
            }
          }
          if (task.input?.purpose === 'PLANNER_FRONTIER_VALIDATE') {
            const frontier = latestFrontierCompletion(store, task);
            const nodeType = task.input?.frontierPhase ?? frontier?.nodeType ?? 'feature';
            try {
              const validated = validateBoundaryContracts(artifactRoot, nodeType, { allowFrontier: true });
              return {
                outcome: 'PASS',
                result: {
                  valid: true,
                  frontier,
                  boundary: validated,
                  error: null,
                  errorCode: null,
                },
              };
            } catch (error) {
              return {
                outcome: 'NOT_PASS',
                result: {
                  valid: false,
                  frontier,
                  error: error?.message ?? String(error),
                  errorCode: error?.code ?? null,
                },
              };
            }
          }
          try {
            materializeIterationFeatureTree(store, task, artifactRoot);
          } catch (error) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, plan: null, error: error?.message ?? String(error), errorCode: error?.code ?? null },
            };
          }
          const rawArtifactPlan = loadPlannerArtifactPlan(artifactRoot);
          if (rawArtifactPlan) {
            try {
              const validated = validatePlannerArtifactPlan(rawArtifactPlan);
              if (hasBoundaryContracts(artifactRoot)) {
                validateBoundaryContracts(artifactRoot, 'feature', { allowFrontier: false });
                validateBoundaryContracts(artifactRoot, 'milestone', { allowFrontier: false });
                validateTaskOwnershipCompilation(artifactRoot, validated.plan.tasks);
              }
              const decomp = iterationRequest(store, task);
              if (decomp?.request?.changeType === 'FEATURE_DECOMPOSITION') {
                if (!hasBoundaryContracts(artifactRoot, 'feature')) {
                  throw new Error('FEATURE_DECOMPOSITION_INCOMPLETE: missing Feature Interface Graph');
                }
                validateFeatureDecompositionIteration(
                  artifactRoot,
                  loadFeatureTreeDiff(artifactRoot),
                  validated.plan.tasks,
                );
              }
              validatePlanAutonomy(validated.plan, planningBatchRequests(store, task));
              return {
                outcome: 'PASS',
                result: { valid: true, plan: validated.plan, error: null, errorCode: null },
              };
            } catch (error) {
              return {
                outcome: 'NOT_PASS',
                result: { valid: false, plan: rawArtifactPlan, error: error?.message ?? String(error), errorCode: error?.code ?? null },
              };
            }
          }

          const candidate = latestLegacyPlanInFlow(store, task, artifactRoot);
          if (!candidate) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, error: 'NO_CANDIDATE_PLAN', plan: null },
            };
          }
          try {
            const validated = validateTechLeadPlan(candidate);
            validatePlanAutonomy(validated.plan, planningBatchRequests(store, task));
            return {
              outcome: 'PASS',
              result: { valid: true, plan: validated.plan, error: null, errorCode: null },
            };
          } catch (error) {
            return {
              outcome: 'NOT_PASS',
              result: { valid: false, plan: candidate, error: error?.message ?? String(error), errorCode: error?.code ?? null },
            };
          }
        },
      }),
      transition: ({ task, result }) => planResultTransition(task, result),
    },

    pm: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        if (scopeOfTask(task) === 'delivery') {
          const debuggerResult = [...(task.history ?? [])].reverse().find(
            entry => entry?.type === 'ROLE_RESULT' && entry?.role === 'project_debugger'
          ) ?? null;
          const prompt = [
            'You are Ariad\'s PM resolving a product/requirement escalation from Project Debugger.',
            'You own product intent and are the only role allowed to request a human decision.',
            'First decide the product question yourself from the durable project brief/spec, explicit prior user decisions, task acceptance criteria, and task history whenever that evidence is sufficient.',
            'Return PRODUCT_DECISION when you can determine the intended behavior. State the concrete product decision in result.decision and give Tech Lead actionable result.guidance. Do not ask the user merely to approve a repair route.',
            'If task history contains HUMAN_DECISION, treat that explicit user answer as authoritative product input. Convert it into PRODUCT_DECISION unless another genuinely unresolved product question remains.',
            'Return NEEDS_HUMAN only when existing product evidence is genuinely insufficient and a new user/product choice is required. Ask the minimum concrete questions needed.',
            'Do not modify implementation files and do not perform engineering decomposition yourself; Tech Lead will translate your product decision into task/plan changes.',
            JSON.stringify({
              project: { id: project.id, spec: project.spec ?? null, mode: project.mode ?? 'NEW' },
              task: {
                id: task.id,
                title: task.title ?? null,
                input: task.input ?? null,
                stage: task.stage,
                history: task.history ?? [],
              },
              debuggerDiagnosis: debuggerResult,
            }, null, 2),
          ].join('\n\n');
          return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
        }
        // Once the user has explicitly approved a validator-passed plan,
        // finalize that decision deterministically. Do not ask the PM model to
        // re-request the same human approval (or silently open an unapproved gate).
        const humanDecision = [...(task.history ?? [])].reverse()
          .find(entry => entry?.type === 'HUMAN_DECISION')?.decision ?? null;
        const explicitlyApproved = typeof humanDecision === 'string'
          ? /approve.*(?:plan|delivery).*authoriz(?:e|ed).*delivery/i.test(humanDecision)
          : humanDecision?.decision === 'APPROVE_DELIVERY' && humanDecision?.startDelivery === true;
        if (explicitlyApproved && predecessorResults(store, task)[0]?.outcome === 'PASS') {
          return {
            provider: codeProviderId,
            executionProvenance: executionProvenanceFor(task),
            execute: async () => ({
              outcome: 'PLAN_ACCEPTED',
              result: {
                reason: 'User approved this fully validated SRPG v2 plan; begin normal Delivery without another Planning iteration.',
                startDelivery: true,
              },
            }),
          };
        }
        const validation = predecessorResults(store, task)[0]?.result ?? null;
        const takeover = isTakeoverPlanningTask(store, task);
        const iteration = iterationRequest(store, task);
        const featureTreeDiff = iteration ? loadFeatureTreeDiff(artifactRoot) : null;
        const prompt = [
          'You are Ariad\'s PM reviewing a validated delivery plan against user intent.',
          'Review both the logical feature/component tree and the milestone structure. The plan must cover the complete currently-known route to project completion, not stop at the next milestone. Near-term work may be detailed and later milestones coarse. Milestones should be useful integrated checkpoints without forcing unnecessary ceremony.',
          'Review the plan as if this product must be handed to real intended users and be good enough to ship, deliver, or sell within its stated scope. Do not accept a plan merely because individual components have isolated tests.',
          'Every important feature and every milestone must have at least one representative end-to-end user scenario: enter through a real supported product entry point, follow the required user-visible steps without shortcuts, exercise the relevant child capabilities together, and reach the intended user-visible outcome.',
          'Do not accept fake E2E that jumps over required workflow state by calling internals directly, injecting final state/data, opening a late screen directly, starting at a final game level, or otherwise bypassing steps an actual user must perform. Focused unit/integration tests may supplement E2E but cannot replace it.',
          'The project/root plan must culminate in a product-level end-to-end journey that demonstrates the intended user can start from a realistic initial state and obtain the product\'s promised value. Require setup/onboarding/persistence/recovery or other lifecycle steps only when they are truly part of that product experience; do not invent unrelated commercial requirements.',
          'For takeover, compare the known authoritative roadmap/docs and the logical tree against the milestone list. Do not accept if known later major scope is missing from milestones, or if the milestone list contains placeholder/unused/TBD entries instead of real checkpoints.',
          'If this is a game project, do not accept a plan whose completion evidence only shows that maps/levels were launched, traversed, or exercised. The product-level E2E must begin from a normal player entry/start state and play through the required progression to an actual win/clear; directly opening the final level or injecting progression state is not a valid full playthrough. Ariad must know how to execute that successful path autonomously without relying on external human players unless the user explicitly requested a human study.',
          takeover
            ? 'This is an existing-project takeover whose required takeover review is still pending. Verify that the reconstruction is coherent, reuse-first, explains uncertainty, and is ready to show the human. Do not treat historical tests/reviews as current evidence. If the human has already supplied a HUMAN_DECISION in task history, incorporate it explicitly.'
            : project.mode === 'TAKEOVER'
              ? 'This is an existing-project TAKEOVER, but the one-time human takeover review has already been satisfied durably at the project level. Do NOT request another takeover/delivery authorization merely because this technical replan changes tasks or scope. If the validated plan preserves user intent and introduces no genuinely new product decision, return PLAN_ACCEPTED and keep normal delivery authorized.'
              : null,
          'Submit the PM decision through the provider\'s structured role-result mechanism when available. Use outcome PLAN_ACCEPTED|PLAN_REVISION_REQUIRED|NEEDS_HUMAN with result.reason, result.startDelivery, optional result.guidance, and result.questions. Use NEEDS_HUMAN only when the requirements/goal themselves are the problem (unclear, contradictory, infeasible, or missing a decision only the requirements owner can make); it is honored only with concrete questions in result.questions - a question-less NEEDS_HUMAN is rejected and treated as a revision request. For any plan problem, use PLAN_REVISION_REQUIRED. Terminal prose or JSON is NOT a result; if you do not submit through the structured mechanism, the attempt fails.',
          'Delivery has a durable gate. Tech Lead/validator/critic can never start delivery. For PLAN_ACCEPTED, set result.startDelivery=true only when you explicitly authorize delivery to begin or resume now. Set it false to keep delivery gated. For TAKEOVER, delivery must remain gated until the required human review has been recorded; only a later PM review may explicitly start it.',
          JSON.stringify({
            project: { id: project.id, spec: project.spec ?? null, mode: project.mode ?? 'NEW', sourcePath: project.sourcePath ?? null },
            takeover,
            featureTreeDiff,
            plan: plannerPublicPlan(validation?.plan ?? latestPlanInFlow(store, task, artifactRoot)),
          }, null, 2),
        ].filter(Boolean).join('\n\n');
        return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
      },
      transition: ({ task, result }) => planResultTransition(task, result) ?? pmDeliveryTransition(task, result),
    },
  };
  roleDefinitions[PLAN_RESULT_TRANSITION] = planResultTransition;
  return roleDefinitions;
}
