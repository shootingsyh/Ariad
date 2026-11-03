import { runAutomatedRegression } from '../runtime/automated-regression.js';
import { deriveExecutionHandoff } from '../runtime/role-run-prompt.js';
import { buildTaskContextArtifact, writeTaskContextArtifact } from '../runtime/task-context-artifact.js';
import { acceptanceCriterionIds } from './acceptance.js';
import { artCapabilityRecommendations, requiredArtCapabilities } from './art-capabilities.js';
import { validatePlanAutonomy } from './autonomy.js';
import { TASK_KINDS, scopeOfTask } from './control-task-policy.js';
import { docsRegimeAdopted, requirementsStatus, validateFeatureDocs } from './project-docs.js';
import { sealRoleInterfaces } from './interface-seal.js';
import { roleExecutorBinding } from './role-executor-binding.js';
import { executorTransitionFromResult } from './role-executor-transition.js';
import { completeTakeoverReview } from './takeover-gate.js';
import { VersionedStore } from './versioned-store.js';
import { promoteVersionedDraft } from './versioned-promotion.js';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PLAN_RESULT_TRANSITION = Symbol('planResultTransition');

// PM plan-review convergence bound: after this many PM_PLAN_REVISION rounds
// in one project store (one iteration), a further rejection parks for a
// human decision instead of spawning another full replan.
export const PM_REVISION_ROUND_CAP = 5;

// Revision rounds are counted per draft lineage: only PM_PLAN_REVISION
// requests created after the most recent PLAN_ACCEPTED pm review count
// toward the cap. Counting every revision in project history lets
// unrelated later batches inherit an exhausted cap (SRPG 2026-11-01:
// batch-26-27 parked for a human on its FIRST revision request because
// the initial-planning rounds were still on the tally). A store without
// task listing falls back to the raw project-wide count.
export function pmRevisionRoundsSinceAcceptance(store, projectId) {
  if (typeof store?.listPlanningRequests !== 'function') return 0;
  const revisions = store.listPlanningRequests(projectId)
    .filter(item => item.request?.purpose === 'PM_PLAN_REVISION');
  if (typeof store?.listTasks !== 'function') return revisions.length;
  let lastAcceptMs = null;
  for (const t of store.listTasks(projectId) ?? []) {
    for (const h of t?.history ?? []) {
      if (h?.type === 'ROLE_RESULT' && h?.role === 'pm' && h?.outcome === 'PLAN_ACCEPTED') {
        const ms = Date.parse(h.completedAt ?? h.at ?? '');
        if (Number.isFinite(ms) && (lastAcceptMs === null || ms > lastAcceptMs)) lastAcceptMs = ms;
      }
    }
  }
  if (lastAcceptMs === null) return revisions.length;
  return revisions.filter(item => {
    const ms = Date.parse(item.createdAt ?? '');
    return Number.isFinite(ms) && ms > lastAcceptMs;
  }).length;
}

import { pmEscalationHasQuestions, flowTasks, predecessorResults, failureCount, roleSealFailureCount, strategyEpoch, planningSkipIds, planningPhaseSkipIds, planningBatchRequests, isTakeoverPlanningTask, iterationRequest, debugHoldPending } from './planning-helpers.js';
import { ARTIST_PROMPT, CODE_NAVIGATION_PROMPT, DEVELOPER_REUSE_PROMPT, TESTER_REUSE_PROMPT, REVIEWER_FRESH_EVIDENCE_PROMPT, deliveryRoleSuffix, plannerPrompt, criticPrompt } from './role-prompts.js';
export function createDefaultV2Roles({
  store,
  providerId = 'pi-agent-session',
  completionProtocol = 'provider_terminal',
  codeProviderId = 'ariad-code',
  workspace,
  sourceControl = null,
  uxReviewEnabled = false,
  debugHoldAfterPlanReview = false,
  enqueuePlanning = null,
  reportIssue = null,
  insertTriagedFixTask = null,
  projectStoreFile = null,
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
          if (task.input?.purpose === 'PLANNER_FINAL_VALIDATE' || task.input?.purpose === 'PLANNER_PM_REVIEW') {
            const gateStage = task.input.purpose === 'PLANNER_FINAL_VALIDATE' ? 'plan_validator' : 'pm';
            return {
              stage: gateStage,
              state: 'READY',
              transitionHistory: {
                type: 'GATE_REPAIR_RETURNED',
                role: 'tech_lead',
                gate: task.input.purpose,
                summary: 'Repair submitted; returning the task to its gate for re-evaluation.',
                at: new Date().toISOString(),
              },
            };
          }
          if (task.input?.purpose === 'PLANNER_DECOMPOSE' || task.input?.purpose === 'PLANNER_FEATURES_FUNCTIONAL') {
            const proj = store.getProject?.(task.projectId);
            // Requirements gate (design 2026-10-31): decomposition of a
            // new version starts only from human-approved requirements.
            // Bounce at submission, before any draft check, so the
            // failure names the missing foundation instead of sending
            // the batch through gates built on unfinalized ground. PM
            // authors the document; a human approves it (hash-pinned).
            if (docsRegimeAdopted(proj.workspace)) {
              const reqStatus = requirementsStatus(proj.workspace);
              if (!reqStatus.approved) {
                return {
                  state: 'NEEDS_HUMAN',
                  transitionHistory: {
                    type: 'REQUIREMENTS_GATE',
                    role: 'tech_lead',
                    summary: reqStatus.exists
                      ? 'REQUIREMENTS_NOT_APPROVED: .ariad/docs/REQUIREMENTS.md exists but is not human-approved (or was edited after approval) \u2014 a human must approve it (ariad project approve-requirements) before decomposition begins.'
                      : 'REQUIREMENTS_NOT_FINALIZED: .ariad/docs/REQUIREMENTS.md is missing \u2014 PM must author the version requirements document (reverse-engineering a baseline from the implemented state when none exists), review it, and a human must approve it (ariad project approve-requirements) before decomposition begins.',
                    at: new Date().toISOString(),
                  },
                };
              }
            }
            let draftOpen = false;
            try {
              const vs = new VersionedStore(store.filePath ?? join(proj.workspace, '.ariad', 'state2.db'));
              try { draftOpen = Boolean(vs.getOpenDraft()); } finally { vs.close(); }
            } catch { draftOpen = false; }
            if (!draftOpen) {
              return {
                state: 'NEEDS_HUMAN',
                transitionHistory: {
                  type: 'TL_PLAN_WITHOUT_DRAFT',
                  role: 'tech_lead',
                  summary: 'Versioned (DB-first) project: author the plan into a database draft with ariad_tree_patch (openDraft, then applyOps) before submitting it. No open draft exists, so this result carries no landable plan.',
                  at: new Date().toISOString(),
                },
              };
            }
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
        if (result.outcome === 'CLEAN' || result.outcome === 'MINOR_ONLY') {
          return {
            state: 'DONE',
            skipTaskIds: [...planningSkipIds(task, task.input?.round), ...planningPhaseSkipIds(task)],
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
        if (task.input?.purpose === 'PLANNER_FINAL_VALIDATE' && result.outcome !== 'PASS') {
          return {
            state: 'NEEDS_HUMAN',
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
        if (task.input?.purpose === 'REQUIREMENTS_AUTHORING') {
          // Requirements stage (design 2026-10-31): the PM has authored
          // or revised the requirements document. NEEDS_HUMAN parks the
          // stage for the human's review; once the document stands
          // human-approved and the PM confirms, the stage closes and
          // normal version planning is enqueued to proceed from it.
          const proj = store.getProject?.(task.projectId);
          const ws = proj?.workspace;
          const approved = ws ? requirementsStatus(ws).approved : false;
          if (approved && result.outcome === 'PLAN_ACCEPTED') {
            enqueuePlanning?.({
              request: {
                purpose: 'INITIAL_PLAN',
                instruction: proj?.goal || 'Replan the project for its new version from the approved requirements and the previous-generation inventory (.ariad/artifacts/inventory/, when present).',
              },
            });
            return {
              state: 'DONE',
              transitionHistory: {
                type: 'REQUIREMENTS_FINALIZED', role: 'pm',
                summary: 'Requirements document is human-approved; version planning (INITIAL_PLAN) has been enqueued to proceed from it.',
                at: new Date().toISOString(),
              },
            };
          }
          if (result.outcome === 'NEEDS_HUMAN' && pmEscalationHasQuestions(result)) {
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'PM_HUMAN_DECISION', role: 'pm',
                summary: result.summary ?? result.result?.reason ?? 'PM has prepared the requirements document for human review.',
                questions: result.result?.questions ?? [],
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          return {
            state: 'NEEDS_HUMAN',
            transitionHistory: {
              type: 'PM_HUMAN_DECISION', role: 'pm',
              summary: 'The requirements document is not yet human-approved, so the requirements stage cannot close.',
              questions: ['Have the PM finalize .ariad/docs/REQUIREMENTS.md, then review it and approve it with ariad project approve-requirements.'],
              at: new Date().toISOString(),
            },
          };
        }
        if (task.input?.purpose === 'LOCAL_REPLAN_REQUIREMENTS') {
          // Local replan, requirements side (owner decision, 2026-11-02):
          // the PM revises REQUIREMENTS.md FIRST when an owner decision
          // mandates a wording change; decomposition depends on this task,
          // so it starts only once the document stands human-approved.
          // When the decision mandates no wording change, the PM confirms
          // that and the gate closes at once.
          const proj = store.getProject?.(task.projectId);
          const ws = proj?.workspace;
          const approved = ws ? requirementsStatus(ws).approved : false;
          const noChange = result.result?.noRequirementsChange === true;
          if (result.outcome === 'PLAN_ACCEPTED' && (approved || noChange)) {
            return {
              state: 'DONE',
              transitionHistory: {
                type: 'LOCAL_REPLAN_REQUIREMENTS_CLEARED', role: 'pm',
                summary: noChange && !approved
                  ? 'PM confirms the owner decision mandates no REQUIREMENTS.md wording change; decomposition may proceed.'
                  : 'REQUIREMENTS.md stands human-approved for this local replan; decomposition may proceed.',
                at: new Date().toISOString(),
              },
            };
          }
          if (result.outcome === 'NEEDS_HUMAN' && pmEscalationHasQuestions(result)) {
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'PM_HUMAN_DECISION', role: 'pm',
                summary: result.summary ?? result.result?.reason ?? 'PM has prepared the requirements revision for human review.',
                questions: result.result?.questions ?? [],
                guidance: result.result?.guidance ?? null,
                at: new Date().toISOString(),
              },
            };
          }
          return {
            state: 'NEEDS_HUMAN',
            transitionHistory: {
              type: 'PM_HUMAN_DECISION', role: 'pm',
              summary: 'The local replan mandates a REQUIREMENTS.md change that is not yet human-approved, so decomposition cannot start.',
              questions: ['Have the PM finalize the REQUIREMENTS.md revision for this local replan, then review it and approve it with ariad project approve-requirements.'],
              at: new Date().toISOString(),
            },
          };
        }
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
          // DB-first landing (the only landing since 2026-10-31): PM
          // approval promotes the open DB draft to prod; there are no
          // planner files to land.
          const versionedProject = store.getProject(task.projectId);
          // Preserve the one-time human takeover review: a reconstructed
          // project parks for the human BEFORE anything is promoted, so
          // the draft stays open and unlanded until the human decides.
          const takeoverGate = isTakeoverPlanningTask(store, task);
          const hasHumanDecision = (task.history ?? []).some(h => h?.type === 'HUMAN_DECISION');
          if (takeoverGate && !hasHumanDecision) {
            return { state: 'NEEDS_HUMAN', transitionHistory: {
              type: 'PM_HUMAN_DECISION', role: 'pm',
              summary: result.result?.reason ?? 'Review the reconstructed project before delivery begins.',
              questions: result.result?.questions?.length ? result.result.questions : ['Approve the reconstructed current state and delivery plan, or provide corrections.'],
              guidance: result.result?.guidance ?? null,
              at: new Date().toISOString(),
            } };
          }
          // Debug hold (operator flag, default off): with the plan
          // accepted but not yet landed, park for the human when the
          // project asks for it. The human releases through the
          // decision channel; the re-review then sees the decision
          // after the DEBUG_HOLD entry and lands normally.
          if (debugHoldAfterPlanReview && debugHoldPending(task)) {
            return { state: 'NEEDS_HUMAN', transitionHistory: {
              type: 'DEBUG_HOLD', role: 'pm',
              summary: (result.result?.reason ?? 'PM accepted the plan.') + ' Debug hold is ON for this project: the accepted plan is not landed and delivery stays closed until the human reviews it and replies with a decision.',
              questions: ['Open delivery for this accepted plan? Reply with a decision to proceed, or give corrections for the plan.'],
              at: new Date().toISOString(),
            } };
          }
          let vlanded;
          let versionedStore = null;
          try {
            versionedStore = new VersionedStore(store.filePath ?? join(versionedProject.workspace, '.ariad', 'state2.db'));
            vlanded = promoteVersionedDraft({ versionedStore, approvedBy: 'pm', workspace: versionedProject.workspace });
          } catch (error) {
            if (error?.code === 'UNIFIED_TASK_DELIVERY_IN_FLIGHT') throw error;
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'VERSIONED_TREE_PLAN_ACCEPTED_BLOCKED', role: 'pm',
                summary: 'Versioned tree plan could not be landed: ' + error.message + '. Delivery remains unchanged.',
                reconcileIssues: error.issues ?? null, at: new Date().toISOString(),
              },
            };
          } finally {
            versionedStore?.close();
          }
          if (takeoverGate) completeTakeoverReview(store, task.projectId);
          const vchanged = vlanded.created.length + vlanded.updated.length + vlanded.obsoleted.length;
          const startDelivery = result.result?.startDelivery === true;
          if (startDelivery) {
            const freshProject = store.getProject(task.projectId);
            if (freshProject && freshProject.deliveryEnabled !== true) {
              store.updateProject(task.projectId, freshProject.version, { deliveryEnabled: true });
            }
          }
          return { state: 'DONE', transitionHistory: {
            type: 'VERSIONED_TREE_PLAN_ACCEPTED', role: 'pm',
            summary: vchanged
              ? 'Accepted DB draft and promoted v' + vlanded.version + ' to prod: ' + vlanded.created.length + ' created, ' + vlanded.updated.length + ' updated, ' + vlanded.obsoleted.length + ' obsoleted.'
              : 'Accepted DB draft and promoted v' + vlanded.version + ' to prod without task changes.',
            taskCount: vlanded.total, landed: vlanded, deliveryGateOpened: startDelivery, at: new Date().toISOString(),
          } };
        }
        if (result.outcome === 'PLAN_REVISION_REQUIRED') {
          // Convergence bound: unbounded PM revision rounds are a system
          // failure mode, not diligence. When the rounds already spent on
          // the current draft since its last acceptance reach the cap,
          // park for a human decision with
          // the latest objections instead of burning another full replan.
          // A human decision recorded on THIS task re-authorizes the
          // loop: the re-review may then enqueue further rounds.
          const revisionRounds = pmRevisionRoundsSinceAcceptance(store, task.projectId);
          const humanReauthorized = (task.history ?? []).some(entry => entry?.type === 'HUMAN_DECISION');
          if (revisionRounds >= PM_REVISION_ROUND_CAP && !humanReauthorized) {
            return {
              state: 'NEEDS_HUMAN',
              transitionHistory: {
                type: 'PM_HUMAN_DECISION', role: 'pm',
                summary: 'Plan review has not converged after ' + revisionRounds + ' PM revision rounds; another automatic replan is unlikely to settle it. Latest PM reason: ' + String(result.result?.reason ?? result.summary ?? '').slice(0, 500),
                guidance: result.result?.guidance ?? null,
                questions: ['Plan review has looped through ' + revisionRounds + ' revision rounds without acceptance. Accept the current draft as-is, give specific direction, or authorize more revision rounds?'],
                at: new Date().toISOString(),
              },
            };
          }
          // Carry the FULL review forward, not just the guidance: the
          // fidelity trace (reason) names exactly which clauses failed
          // and their current defective text, and the rejected draft
          // version pins the lineage the revision must continue. The
          // rejected draft stays open; the next batch edits it in
          // place (see the PM PLAN REVISION prompt section and the
          // VersionedStore discard guard).
          let rejectedDraftVersion = null;
          try {
            const revisionProject = store.getProject?.(task.projectId);
            const draftDbPath = store.filePath ?? (revisionProject?.workspace ? join(revisionProject.workspace, '.ariad', 'state2.db') : null);
            if (draftDbPath && existsSync(draftDbPath)) {
              const vs = new VersionedStore(draftDbPath);
              try { rejectedDraftVersion = vs.getOpenDraft()?.version ?? null; } finally { vs.close(); }
            }
          } catch { rejectedDraftVersion = null; }
          enqueuePlanning?.({
            request: {
              purpose: 'PM_PLAN_REVISION',
              guidance: result.result?.guidance ?? result.result ?? null,
              reason: result.result?.reason ?? result.summary ?? null,
              rejectedDraftVersion,
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
  };

  const PLAN_SIGNALS = {
    PLAN: { 'DONE:': 'FINISH', 'READY:tech_lead': 'ADVANCE', 'READY:plan_validator': 'REVALIDATE', 'READY:pm': 'ESCALATE', 'READY:project_debugger': 'ROUTE_DEBUG', 'NEEDS_HUMAN:': 'BLOCKED' },
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
  const planResultTransition = (task, result) => {
    if (task.taskKind !== TASK_KINDS.PLANNING) return null;
    const body = planTransitionBodies[task.stage];
    if (!body) return null;
    let legacy = body({ task, result });
    if (!legacy) return null;
    // Escalation whitelist: a planning-stage failure is machinery, not a
    // human decision. Bodies still report it as NEEDS_HUMAN; the bridge
    // converts it into the executor's recovery progression - back to the
    // tech lead twice, then to the project debugger, whose terminal
    // diagnosis lands in SYSTEM_BLOCKED. Deliberate human channels pass
    // through untouched: PM_HUMAN_DECISION (the PM's requirements call and
    // the takeover review), REQUIREMENTS_GATE (the decompose gate waiting
    // on human approval of the requirements document), DEBUG_HOLD (the
    // operator debug hold after PM plan acceptance), and the debugger's
    // own terminal diagnosis.
    if (legacy.state === 'NEEDS_HUMAN' && task.stage !== 'project_debugger'
      && legacy.transitionHistory?.type !== 'PM_HUMAN_DECISION'
      && legacy.transitionHistory?.type !== 'REQUIREMENTS_GATE'
      && legacy.transitionHistory?.type !== 'DEBUG_HOLD') {
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
    // The PM's deliberate human gate (requirements call / takeover review
    // / debug hold) exits the executor through its own terminal, not the
    // failure path.
    if (['PM_HUMAN_DECISION', 'REQUIREMENTS_GATE', 'DEBUG_HOLD'].includes(legacy.transitionHistory?.type)) signal = 'HUMAN_GATE';
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
    const roleBoundaryContext = null; // file-bundle boundary context retired with the legacy pipeline; contracts live in the DB spec.
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
      ...(task.stage === 'tech_lead' && projectStoreFile ? { projectStoreFile } : {}),
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

  // Feature-phase validation (three-pass pipeline): passes 1 and 2 land
  // feature contracts and documents before any task tree exists, so the
  // full-draft verdict does not apply yet. A phase draft passes when its
  // contracts are structurally valid and every contract this draft adds
  // or changes already carries its feature document and index entry.
  // Task-tree problems are expected at this point - pass 3 owns the task
  // tree - and are reported as deferred advisories for the critic, not
  // failures. The full validation still runs on the finished plan.
  const validateFeaturePhase = ({ task, validatorProject }) => {
    const phase = task.input?.phase === 'nonfunctional' ? 'nonfunctional' : 'functional';
    const fail = (error, errorCode) => ({
      outcome: 'NOT_PASS',
      result: { valid: false, plan: null, phase, error, errorCode },
    });
    const draftStore = new VersionedStore(store.filePath ?? join(validatorProject.workspace, '.ariad', 'state2.db'));
    try {
      const draft = draftStore.getOpenDraft();
      if (!draft) {
        return fail('NO_OPEN_DRAFT: this is a DB-first (versionedTree) project - author the feature tree into a database draft with the ariad_tree_patch tool (openDraft, then applyOps) before validation', 'NO_OPEN_DRAFT');
      }
      const contracts = draftStore.listSpecContracts(draft.version);
      if (!contracts.length) {
        return fail('FEATURE_DRAFT_EMPTY: the open DB draft contains no feature contracts - author the feature tree into it with ariad_tree_patch applyOps before validation', 'FEATURE_DRAFT_EMPTY');
      }
      const allErrors = draftStore.validateVersion(draft.version);
      const isContractError = e => e.startsWith('contract ') || e.includes('feature tree cycle');
      const contractErrors = allErrors.filter(isContractError);
      if (contractErrors.length) {
        return fail('DRAFT_INVALID: ' + contractErrors.join('; '), 'DRAFT_INVALID');
      }
      try {
        const diff = draftStore.diffDraft();
        validateFeatureDocs(validatorProject.workspace, {
          changedNodeIds: [...diff.contracts.added, ...diff.contracts.changed],
          removedNodeIds: diff.contracts.removed,
        });
      } catch (error) {
        return fail(error?.message ?? String(error), error?.code ?? 'PROJECT_DOCS_INCOMPLETE');
      }
      return {
        outcome: 'PASS',
        result: {
          valid: true,
          phase,
          plan: {
            source: 'db-draft-features',
            version: draft.version,
            phase,
            contractCount: contracts.length,
            contracts,
            tasks: draftStore.listSpecTasks(draft.version),
            taskErrorsDeferredToTaskPass: allErrors.filter(e => !isContractError(e)),
          },
          error: null,
          errorCode: null,
        },
      };
    } finally {
      draftStore.close();
    }
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

    tech_lead: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        if (task.taskKind === 'ADHOC_ANALYSIS') {
          const prompt = [
            'You are the Ariad Tech Lead carrying out an isolated ad-hoc analysis.',
            'Read and investigate the repository as needed. Do not modify any files, planning artifacts, task graph, or implementation.',
            'Do not initiate Delivery, Replan, or task creation. Return findings only.',
            'Request:', task.input.instruction,
            'Context:', JSON.stringify(task.input.context ?? {}),
            'Return outcome PLANNED with your findings through the structured role-result tool.',
          ].join('\n');
          return prepareLlm(task, prompt, { sessionKey: 'adhoc:' + task.projectId + ':' + task.id });
        }
        const prompt = [
          plannerPrompt({ store, project, task, artifactRoot }),
          ...(task.input?.previousGateFailure ? [
            '',
            'PREVIOUS GATE FAILURE',
            'Your previous submission was rejected at a planning gate. Fix exactly this first before resubmitting:',
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
      prepare: ({ project, task }) => prepareLlm(task, criticPrompt({ store, project, task, artifactRoot })),
      transition: ({ task, result }) => planResultTransition(task, result),
    },

    plan_validator: {
      prepare: ({ task }) => ({
        provider: codeProviderId,
        executionProvenance: executionProvenanceFor(task),
        execute: async () => {
          const validatorProject = store.getProject(task.projectId);
          // DB-first validation (the only validation since 2026-10-31):
          // the verdict rests on the open DB draft alone.
            // Requirements gate, front-moved from promotion (design
            // 2026-10-31): a DB draft is validated only against
            // human-approved requirements, so a decomposition can no
            // longer be built and reviewed on unfinalized ground. PM
            // authors the document; the human approves it (hash-pinned).
            if (docsRegimeAdopted(validatorProject.workspace)) {
              const reqStatus = requirementsStatus(validatorProject.workspace);
              if (!reqStatus.exists) {
                return {
                  outcome: 'NOT_PASS',
                  result: { valid: false, plan: null, error: 'REQUIREMENTS_NOT_FINALIZED: .ariad/docs/REQUIREMENTS.md is missing \u2014 PM must author the version requirements document (reverse-engineering a baseline from the implemented state when none exists) and a human must approve it before a DB draft can be validated', errorCode: 'REQUIREMENTS_NOT_FINALIZED' },
                };
              }
              if (!reqStatus.approved) {
                return {
                  outcome: 'NOT_PASS',
                  result: { valid: false, plan: null, error: 'REQUIREMENTS_NOT_APPROVED: the requirements document was edited after approval (or never approved) \u2014 a human must approve it (ariad project approve-requirements) before a DB draft can be validated', errorCode: 'REQUIREMENTS_NOT_APPROVED' },
                };
              }
            }
            if (task.input?.purpose === 'PLANNER_VALIDATE_FEATURES') {
              return validateFeaturePhase({ task, validatorProject });
            }
            const draftStore = new VersionedStore(store.filePath ?? join(validatorProject.workspace, '.ariad', 'state2.db'));
            try {
              const draft = draftStore.getOpenDraft();
              if (!draft) {
                return {
                  outcome: 'NOT_PASS',
                  result: { valid: false, plan: null, error: 'NO_OPEN_DRAFT: this is a DB-first (versionedTree) project - the plan must be authored into a database draft with the ariad_tree_patch tool (openDraft, then applyOps); planner artifact files alone cannot be promoted', errorCode: 'NO_OPEN_DRAFT' },
                };
              }
              const draftTasks = draftStore.listSpecTasks(draft.version);
              const draftContracts = draftStore.listSpecContracts(draft.version);
              if (draftTasks.length === 0) {
                return {
                  outcome: 'NOT_PASS',
                  result: { valid: false, plan: null, error: 'DRAFT_EMPTY: the open DB draft contains no tasks - author the tree into it with ariad_tree_patch applyOps before validation', errorCode: 'DRAFT_EMPTY' },
                };
              }
              const draftErrors = draftStore.validateVersion(draft.version);
              if (draftErrors.length) {
                return {
                  outcome: 'NOT_PASS',
                  result: { valid: false, plan: null, error: 'DRAFT_INVALID: ' + draftErrors.join('; '), errorCode: 'DRAFT_INVALID' },
                };
              }
              // Autonomy policy, carried into the DB-first validator: a
              // plan may not require external/manual human labor unless
              // the human explicitly requested it.
              try {
                validatePlanAutonomy({ tasks: draftTasks }, planningBatchRequests(store, task));
              } catch (error) {
                return {
                  outcome: 'NOT_PASS',
                  result: { valid: false, plan: null, error: error?.message ?? String(error), errorCode: error?.code ?? 'INVALID_AUTONOMY_REQUIREMENT' },
                };
              }
              // DB-first verdict rests on the draft alone: do not fall
              // through to the on-disk planner bundle below - it is a
              // legacy medium for versioned projects and a stale bundle
              // must not fail a valid draft (SRPG, 2026-10-31).
              // The PASS payload carries the full draft content (tasks
              // and contracts), because the critic and the PM judge
              // this plan from the validator result: with only a stub
              // {version, taskCount} both of them accepted a plan they
              // could not see (SRPG art iteration, 2026-11-01).
              return {
                outcome: 'PASS',
                result: { valid: true, plan: { source: 'db-draft', version: draft.version, taskCount: draftTasks.length, tasks: draftTasks, contracts: draftContracts }, error: null, errorCode: null },
              };
            } finally {
              draftStore.close();
            }
        },
      }),
      transition: ({ task, result }) => planResultTransition(task, result),
    },

    pm: {
      sessionPolicy: 'persistent',
      prepare: ({ project, task }) => {
        if (task.input?.purpose === 'LOCAL_REPLAN_REQUIREMENTS') {
          const reqStatus = requirementsStatus(project.workspace);
          const humanDecision = [...(task.history ?? [])].reverse()
            .find(entry => entry?.type === 'HUMAN_DECISION') ?? null;
          const prompt = [
            'You are Ariad\'s PM handling the requirements side of a LOCAL REPLAN. This task runs before any decomposition: planning for this batch proceeds only from requirements that stand in their final, human-approved form.',
            'Read the project-owner decisions in the payload requests. Decide whether any of them mandates a change to the wording of .ariad/docs/REQUIREMENTS.md.',
            'If one does: revise the document in place with the smallest edit that carries the decision - keep its structure and every settled statement that still stands, and keep the document high-level. Then submit NEEDS_HUMAN with result.questions asking the human to review the edited .ariad/docs/REQUIREMENTS.md and approve it (ariad project approve-requirements ' + project.id + '). Never submit PLAN_ACCEPTED for a wording change the human has not yet approved.',
            'If the task history already contains a HUMAN_DECISION and the payload\'s requirementsStatus shows the document approved, submit PLAN_ACCEPTED to release decomposition.',
            'If no decision in the batch mandates a requirements wording change, submit PLAN_ACCEPTED with result.noRequirementsChange=true.',
            'Do not decompose, do not author or edit plan tasks, and do not edit any document other than .ariad/docs/REQUIREMENTS.md in this task.',
            JSON.stringify({
              project: { id: project.id, mode: project.mode ?? 'NEW', workspace: project.workspace },
              requirementsStatus: reqStatus,
              humanDecision,
              requests: task.input?.requests ?? [],
            }, null, 2),
          ].join('\n\n');
          return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
        }
        if (task.input?.purpose === 'REQUIREMENTS_AUTHORING') {
          const reqStatus = requirementsStatus(project.workspace);
          const humanDecision = [...(task.history ?? [])].reverse()
            .find(entry => entry?.type === 'HUMAN_DECISION') ?? null;
          const prompt = [
            'You are Ariad\'s PM authoring the project requirements document. This is a requirements stage, not a plan review: no decomposition exists yet, and none may start until the document you produce is finalized and human-approved.',
            'REVISE, DO NOT REGENERATE: if .ariad/docs/REQUIREMENTS.md already exists - the previous version\'s document, left in the workspace for exactly this - revise THAT document in place: keep its structure and every settled statement that still stands, fold the new requirements in, adjust current-state sections only where the product actually changed, and replace the delta section with this version\'s delta. Never rewrite the document from scratch when one exists; only author a new document where none exists. Write .ariad/docs/REQUIREMENTS.md now: read first (the existing documents under .ariad/docs, the previous generation\'s inventory under .ariad/artifacts/inventory/ - INVENTORY.md, SCHEMA.md and the JSON dumps, when present - and the code), then land the document with your edit/write tools. The document is the single source of truth for what the product must be: high-level, plain language, written for humans, no internal IDs and no provenance annotations \u2014 it does not cite where requirements came from; it is where they live.',
            'If no requirements document exists, establish what the product actually is today from what the previous version actually implemented, and describe that implemented product, organized under the requirement categories customary for this product domain \u2014 for a game: core experience and gameplay, game systems, content, presentation and art, audio, UI and UX, save and lifecycle, platform and performance, quality floor, release readiness \u2014 using a domain template under .ariad/docs/templates/ when the project provides one, instead of categories invented on the spot. Only what is actually implemented belongs in the document. Write carried-forward content as plain present-tense product description: the document describes the product as it stands; it does not narrate what a previous version did. Cover every category the template lists that applies to this product.',
            'Then fold the human\'s new requirements for the coming version (the request instruction in the payload, plus any HUMAN_DECISION in the task history) into the same document, and close the document with a delta section stating ONLY what this version adds, changes, or removes, plus what is explicitly out of scope - the delta the Tech Lead will plan from. The delta must not recount, list, or summarize what the previous version already implemented. Keep the whole document high-level: no numeric tuning values, no mechanic formulas or constants, no implementation detail; detail belongs to the Tech Lead\'s feature documents, and milestones carry no requirements detail.',
            'Review your own draft twice \u2014 re-read it once against the implemented state and once against the human\'s stated requirements and the writing standards (comprehensive per the template, high-level throughout with no design constants, a delta naming only this version\'s improvements), fixing what you find \u2014 before presenting it.',
            'External references: when a requirement turns on outside references - benchmarks, comparable products, prior art - use your web tools (ariad_web_search, then ariad_web_fetch on the promising results) and ground the supporting material in real sources, recording each source URL next to what it is meant to show. Recollection alone is not research: if a search genuinely returns nothing usable, say so plainly in your submission instead of presenting remembered detail as collected reference.',
            'Submit through the structured role-result mechanism. When the document is written and ready, submit NEEDS_HUMAN with result.questions asking the human to review .ariad/docs/REQUIREMENTS.md and approve it (ariad project approve-requirements ' + project.id + '). If the task history already contains a HUMAN_DECISION and the payload\'s requirementsStatus shows the document approved, submit PLAN_ACCEPTED with result.startDelivery=false to close this stage. If a genuine requirements question that only the human can answer blocks the writing itself, submit NEEDS_HUMAN with those concrete questions instead.',
            JSON.stringify({
              project: { id: project.id, mode: project.mode ?? 'NEW', workspace: project.workspace },
              requirementsStatus: reqStatus,
              humanDecision,
              requests: task.input?.requests ?? [],
            }, null, 2),
          ].join('\n\n');
          return prepareLlm(task, prompt, { sessionKey: project.pmBinding ?? project.id });
        }
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
        // Inherited review context: a fresh per-review session must not
        // lose the record. Assemble, from the store, (a) the previous
        // review round's verdict and guidance - as a checklist to verify
        // against the CURRENT draft, never as the reviewer's own memory -
        // and (b) every human decision recorded on this project's tasks,
        // which binds this review regardless of which task received it.
        let priorReview = null;
        const inheritedHumanDecisions = [];
        try {
          const allTasks = typeof store?.listTasks === 'function' ? store.listTasks(task.projectId) : [];
          for (const other of allTasks) {
            for (const entry of other.history ?? []) {
              if (entry?.type === 'HUMAN_DECISION') {
                inheritedHumanDecisions.push({ taskId: other.id, at: entry.at ?? null, decision: entry.decision ?? null });
              }
              if (other.id !== task.id && other.stage === 'pm' && other.input?.purpose === 'PLANNER_PM_REVIEW' && entry?.type === 'ROLE_RESULT') {
                const candidate = {
                  taskId: other.id,
                  outcome: entry.outcome ?? null,
                  summary: entry.summary ?? null,
                  guidance: entry.result?.guidance ?? null,
                  completedAt: entry.completedAt ?? '',
                };
                if (!priorReview || String(candidate.completedAt) >= String(priorReview.completedAt)) priorReview = candidate;
              }
            }
          }
          inheritedHumanDecisions.sort((x, y) => String(x.at ?? '').localeCompare(String(y.at ?? '')));
        } catch {
          priorReview = null;
        }
        const prompt = [
          'You are Ariad\'s PM reviewing a validated delivery plan against user intent.',
          'Your yardstick is the human-approved requirements document at .ariad/docs/REQUIREMENTS.md (approval pinned by hash in .ariad/docs/approvals.json), which you maintain: fold the human\'s latest requirements into it and obtain human approval before any new-version decomposition is planned. If this plan embodies product requirements that are not in the approved document, do not accept it — return PLAN_REVISION_REQUIRED and say the requirements must be re-finalized with the human first.',
          'REQUIREMENTS AUTHORSHIP: You own .ariad/docs/REQUIREMENTS.md. It is the single source of truth for what the product must be, written for humans: high-level, plain language, no internal IDs and no provenance annotations \u2014 the document does not cite where its requirements came from; it is where they live. When a project has no requirements document (the normal case for a taken-over or iterated project), authoring one is your first duty, before judging any decomposition: establish what the product actually is today from what the previous version actually implemented and describe that implemented product \u2014 the legacy record, the existing project documents, and the code \u2014 organized under the requirement categories customary for the product domain (use a domain template under .ariad/docs/templates/ when the project has one) instead of categories invented on the spot. Then fold the human\'s new requirements for the coming version into the same document, and close it with a delta section stating ONLY what this version adds, changes, or removes, plus what is explicitly out of scope - the delta must not recount what the previous version already implemented. Keep the root document high-level, at the level a product owner would write: no numeric tuning values, no mechanic formulas or constants; detail belongs to the Tech Lead\'s feature documents, and milestones carry no requirements detail. Review your own draft twice before presenting it. When the document is ready, return NEEDS_HUMAN with result.questions asking the human to review the document and approve it (ariad project approve-requirements). If a plan reaches you while the document is missing or unapproved, do not judge the plan on its merits \u2014 say the requirements must be finalized and approved first.',
          'Review both the logical feature/component tree and the milestone structure. The plan must cover the complete currently-known route to project completion, not stop at the next milestone. Near-term work may be detailed and later milestones coarse. Milestones should be useful integrated checkpoints without forcing unnecessary ceremony.',
          'Review the plan as if this product must be handed to real intended users and be good enough to ship, deliver, or sell within its stated scope. Do not accept a plan merely because individual components have isolated tests.',
          'Every important feature and every milestone must have at least one representative end-to-end user scenario: enter through a real supported product entry point, follow the required user-visible steps without shortcuts, exercise the relevant child capabilities together, and reach the intended user-visible outcome.',
          'Do not accept fake E2E that jumps over required workflow state by calling internals directly, injecting final state/data, opening a late screen directly, starting at a final game level, or otherwise bypassing steps an actual user must perform. Focused unit/integration tests may supplement E2E but cannot replace it.',
          'The project/root plan must culminate in a product-level end-to-end journey that demonstrates the intended user can start from a realistic initial state and obtain the product\'s promised value. Require setup/onboarding/persistence/recovery or other lifecycle steps only when they are truly part of that product experience; do not invent unrelated commercial requirements.',
          'PLAN FIDELITY - JUDGE THE DRAFT ITSELF, NOT SUMMARIES OF IT: the payload plan carries the full draft (every task with intent, acceptanceCriteria, testStrategy and flags, plus the feature contracts). Trace every requirement in the approved requirements document - above all every addition or change in its delta - to the task or tasks that carry it, and judge each carrying task by the text of its own acceptanceCriteria. Return PLAN_REVISION_REQUIRED when you find any of these: (a) a requirement is carried only by verification or regression wording (reuse the existing implementation, verify, repair only what verification finds) while the document presents it as something this version adds, changes, or completes, and the plan names no concrete existing evidence that the current implementation already satisfies it exactly as written - work the document calls for must be produced by a production task, not presumed already present; (b) acceptance criteria dilute an enumerated requirement into generic language (for example: no placeholders remain, assets are consistent) that would pass without the enumerated specifics existing - every enumerated item in the document (each named action, variant, deliverable, or member of a list) must appear in the acceptance criteria of some task, complete and not sampled; a list covered only in part is not covered; (c) a visual or media requirement is carried by tasks lacking the markings the quality flow relies on - media production needs art.required with named deliverables and the artist stage, and visual delivery needs ux.required so the rendered-evidence review actually runs; (d) the plan treats existing assets or implementation as satisfying a requirement on the basis of names, counts, or file presence alone, without evidence at the granularity the requirement enumerates. When you return PLAN_REVISION_REQUIRED for any of these, quote the requirement and name the missing or diluted item in result.guidance so the Tech Lead can repair it without guessing. Validator PASS and critic CLEAN establish structure only; they are not evidence of fidelity, and accepting on their summaries alone is a review failure. ACCOUNTING - YOUR RESULT MUST CARRY THE TRACE ITSELF: in result.reason (and in result.guidance when you revise), list every enumerated item you traced, one line per item at clause granularity, naming the carrying task and your verdict. A document section is a list of clauses, not a headline: an item buried in the middle of a dense paragraph (an expression or scar variant set inside a presentation paragraph, one named effect inside an effects list) counts exactly as much as a headline item, and the sections the delta touches are in scope, not only the lines of the delta itself. An acceptance whose reason does not enumerate the traced items is an incomplete review: if you cannot account for an item, return PLAN_REVISION_REQUIRED for it instead of accepting.',
          'For takeover, compare the known authoritative roadmap/docs and the logical tree against the milestone list. Do not accept if known later major scope is missing from milestones, or if the milestone list contains placeholder/unused/TBD entries instead of real checkpoints.',
          'If this is a game project, do not accept a plan whose completion evidence only shows that maps/levels were launched, traversed, or exercised. The product-level E2E must begin from a normal player entry/start state and play through the required progression to an actual win/clear; directly opening the final level or injecting progression state is not a valid full playthrough. Ariad must know how to execute that successful path autonomously without relying on external human players unless the user explicitly requested a human study.',
          takeover
            ? 'This is an existing project (takeover and iteration are one procedure) whose required human review is still pending. Verify that the reconstruction is coherent, reuse-first, explains uncertainty, and is ready to show the human. Do not treat historical tests/reviews as current evidence. If the human has already supplied a HUMAN_DECISION in task history, incorporate it explicitly.'
            : project.mode === 'TAKEOVER'
              ? 'This is an existing project (takeover and iteration are one procedure), and the one-time human takeover review has already been satisfied durably at the project level. Do NOT request another takeover/delivery authorization merely because this technical replan changes tasks or scope. If the validated plan preserves user intent and introduces no genuinely new product decision, return PLAN_ACCEPTED and keep normal delivery authorized.'
              : null,
          'HUMAN DECISIONS ARE AUTHORITATIVE: the payload humanDecision field carries the human\'s answer to a parked review (a debug hold or another human gate), when one exists. Follow it exactly. If it asks for any change or correction to the plan, return PLAN_REVISION_REQUIRED and carry the requested changes verbatim in result.guidance - never re-accept the unchanged plan over a correction. Accept the plan only when the decision unconditionally approves or releases it, or when no decision is present and the plan merits acceptance on its own.',
          'INHERITED CONTEXT: the payload carries priorReview (the previous review round\'s verdict and guidance) and humanDecisions (every human decision recorded on this project\'s tasks). You review in a fresh session by design: judge the CURRENT draft in the payload, not any earlier draft. Treat priorReview strictly as a checklist to verify against the current draft text - an objection whose demanded text is present in the current draft is resolved; never re-demand it. Human decisions are authoritative instructions whenever they were given, not only the decision attached to this task.',
          'Submit the PM decision through the provider\'s structured role-result mechanism when available. Use outcome PLAN_ACCEPTED|PLAN_REVISION_REQUIRED|NEEDS_HUMAN with result.reason, result.startDelivery, optional result.guidance, and result.questions. Use NEEDS_HUMAN only when the requirements/goal themselves are the problem (unclear, contradictory, infeasible, or missing a decision only the requirements owner can make); it is honored only with concrete questions in result.questions - a question-less NEEDS_HUMAN is rejected and treated as a revision request. For any plan problem, use PLAN_REVISION_REQUIRED. Terminal prose or JSON is NOT a result; if you do not submit through the structured mechanism, the attempt fails.',
          'Delivery has a durable gate. Tech Lead/validator/critic can never start delivery. For PLAN_ACCEPTED, set result.startDelivery=true only when you explicitly authorize delivery to begin or resume now. Set it false to keep delivery gated. For an existing project whose required human review/requirements approval has not been recorded, delivery must remain gated until it has been; only a later PM review may explicitly start it.',
          JSON.stringify({
            project: { id: project.id, spec: project.spec ?? null, mode: project.mode ?? 'NEW', sourcePath: project.sourcePath ?? null },
            takeover,
            plan: validation?.plan ?? null,
            humanDecision,
            priorReview,
            humanDecisions: inheritedHumanDecisions,
          }, null, 2),
        ].filter(Boolean).join('\n\n');
        // Plan review judges one specific draft: use a fresh session per
        // review task instead of the PM persistent authoring session. A
        // shared session anchors the reviewer on its own earlier traces,
        // and it starts re-demanding text the current draft already
        // carries (SRPG 2026-11-01: nine revision rounds, with clauses
        // demanded verbatim that had been in the validated plan since
        // round six). A re-run of the SAME review task (a human decision
        // on a parked review) reuses its session, so the decision lands
        // in the context that produced that review.
        return prepareLlm(task, prompt, { sessionKey: `pm-review:${task.projectId}:${task.id}` });
      },
      transition: ({ task, result }) => planResultTransition(task, result) ?? pmDeliveryTransition(task, result),
    },
  };
  roleDefinitions[PLAN_RESULT_TRANSITION] = planResultTransition;
  return roleDefinitions;
}
