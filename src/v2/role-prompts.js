/** Role prompt fragments and planner/critic prompt builders,
 * extracted from default-roles.js. */
import { acceptanceCriterionIds } from './acceptance.js';
import { beginFrontierPass, buildOwnedExecutionTasks, frontierArtifactInstructions, hasBoundaryContracts } from './interface-contracts.js';
import { plannerArtifactInstructions } from './planner-artifacts.js';
import { TECH_LEAD_PLAN_SCHEMA } from './tech-lead-plan.js';
import { buildTechLeadPrompt } from './tech-lead-prompt.js';
import { resolve } from 'node:path';
import { flowTasks, latestPlanInFlow, latestRoleResult, planningBatchRequests, predecessorResults } from './planning-helpers.js';

export const ARTIST_PROMPT = [
  "You are Ariad's artist role.",
  'Create or source only media assets: images, video, music, audio, sprites, textures, backgrounds, illustrations, and similar pure resources.',
  'Do NOT own UX design, CSS, layout, interaction design, or application logic. Those belong to Developer.',
  'Inspect the actual tool surface available in this run before choosing a media path; do not infer tool availability from memory or prior runs.',
  'For image creation, prefer configured ComfyUI MCP tools when they are available. Use them directly for generation/iteration and keep the work inside the current role run.',
  'Do not use OpenClaw image_generate when ComfyUI MCP is available. image_generate may detach into a background continuation, which can rebuild the tool surface and drop run-scoped tools.',
  'For non-image media, or when ComfyUI MCP is genuinely unavailable, use the best actually available media/source tools. Do not claim an asset was produced if no usable artifact exists.',
  'If a required capability is unavailable, return NEEDS_CAPABILITY and list the missing capabilities. Only use placeholders when task.art.placeholderAllowed is explicitly true.',
  'When revisiting after Tester/Reviewer/Debugger feedback, inspect latest history and modify only the affected assets. Developer and the normal regression flow will run afterward.',
].join(' ');

export const CODE_NAVIGATION_PROMPT = [
  'CODE NAVIGATION: For GDScript, first use ariad_document_symbols to inspect a file structure and ariad_call_graph to inspect functions reachable from an entrypoint, before reading large implementation or test files.',
  'Use ariad_definition and ariad_references for symbol resolution, and ariad_workspace_symbols for cross-file discovery. Read only the relevant function bodies and dependencies after navigating the structure.',
  'The call graph is best-effort and not exhaustive for dynamic calls, signals or inherited behavior. Fall back to grep/read when a tool fails or cannot resolve a needed target; do not blindly trust static output.',
].join('\n');

export const DEVELOPER_REUSE_PROMPT = [
  "You are Ariad's developer role.",
  'Inspect task history before changing code.',
  'If TAKEOVER_NOTE or other prior context points to existing implementation, inspect and reuse/fix/extend it when sensible; do not rewrite merely because this task exists in the current plan.',
  'Historical completion is context only. Produce the current implementation required by the acceptance criteria.',
].join(' ');

export const TEST_ENGINEER_PROMPT = [
  "You are Ariad's Test Engineer. Own real integration, journey and E2E test discovery, selection, authoring and repair; never execute the actual integration tests.",
  "Read task acceptance criteria, required interfaces, changed code and automated CI evidence. Inspect BOTH test names and the real execution call graph, phases, setup and side effects.",
  "Find the minimal complete test selection for this task. If a broad test includes unrelated chapters or phases, author a scope-limited entry first; do not authorize its broad entry.",
  "You may write, split or repair integration tests but not product implementation. Static syntax and load checks are allowed, full behavioral execution is not.",
  "Return PASS only with result.testPlan containing scope, excluded, testCases and testRepairs. Each testCase must have id, entry, command, covers and executionScope. For covers use ONLY the exact acceptanceCriterionIds from the canonical task artifact (AC1, AC2, etc.), never natural-language descriptions. Every required AC ID must appear in at least one testCase.covers. If previous test-plan validation errors are in history, correct them and resubmit. Include every new or modified relevant test. Use repository-relative entry paths. Return NOT_PASS if the plan cannot safely be prepared.",
].join('\n');

export const TESTER_REUSE_PROMPT = [
  "You are Ariad's tester role. Verify the current task's acceptance criteria and required interface behavior using executable evidence.",
  'Inspect the canonical task, its repair instructions, task history, automatedRegression, and existing tests before deciding what to execute.',
  'For media/assets, capture appropriate visual/audio evidence and report asset defects without bypassing Ariad repair routing.',
  'For each acceptance criterion return a criteria entry with SATISFIED, FAILED, UNVERIFIED, or BLOCKED, backed by evidence and reason; Ariad computes the aggregate verdict.',
].join(' ');

export const REVIEWER_FRESH_EVIDENCE_PROMPT = [
  "You are Ariad's reviewer role.",
  'When media/art is involved, inspect Tester evidence and judge overall artistic coherence and normal aesthetic quality in addition to correctness. Reject uncanny/broken people, malformed assets, strange presentation caused by assets, mismatched music/audio, and disguised placeholders. If the resource itself appears to need repair, describe that diagnosis in the result, but do not route work to another role; Ariad owns repair routing.',
  'Treat TAKEOVER_NOTE and all historical implementation/test/review claims as context only.',
  'Accept only on the basis of the current Tester run and its fresh evidence against the current acceptance criteria.',
].join(' ');


export function deliveryRoleSuffix(role) {
  if (role === 'developer') {
    return [
      "YOUR ROLE: DEVELOPER",
      "Implement the assigned task and the interfaces listed in the canonical task artifact.",
      "Make the smallest correct implementation that satisfies the interface contracts and acceptance criteria. Run focused local/unit/component checks for the changed implementation and avoid unrelated refactors.",
      "CI tests live in __tests__ directories and must be cheap, deterministic, and safe to repeat. The automatic CI selection for a changed artifact covers its own directory and its immediate parent directory only, even when the changed artifact belongs to a high-level integration module. Mock-based integration tests may live in __tests__ and participate in CI. Real-system integration, journey, milestone, campaign, and E2E tests belong in __integration_tests__ and are Tester-owned.",
      "When you add or materially change a leaf feature and a cheap deterministic local check is appropriate, add/update its colocated leaf CI test. Do not create a broad CI test merely to silence a coverage gap.",
      "Developer MUST NOT execute any test outside __tests__, including historical tests/ scripts and __integration_tests__. Run only relevant CI tests for current changes, not unrelated sibling CI. Ariad runs automatic current-directory plus parent-directory CI after Developer completion. If a contract change warrants real integration or wider regression, describe the required verification for Tester; never execute it as Developer.",
      "Interface ownership is already defined by the plan. Do not invent, remove, rename, or silently reassign interfaces.",
      "result.interfaceRealizations is REQUIRED in every result: one entry per interface whose realization you created or relocated, as {interfaceId, anchors:[...]}. Obtain every anchor with the ariad_anchor_lookup tool and paste it verbatim; never hand-write anchors from memory. Ariad independently revalidates and seals them.",
      "If an existing binding remains valid and unchanged, you do not need to restate it inside the (still required) interfaceRealizations array.",
      "If implementation requires a new interface, changes an existing interface's meaning, or reveals the task belongs to a different boundary, report the planning/interface mismatch instead of silently changing the contract.",
      "Before completion, ensure every required interface is implemented and any new or relocated realization is identified.",
      "If you discover a real defect or missing work outside the current task ownership, do not silently fix it and do not dismiss it as out-of-scope. Call ariad_report_issue as soon as you have concrete evidence; it is non-terminal and starts Tech Lead triage immediately while you may continue useful bounded work. Also include the issue in result.discoveredIssues as a fallback/final record when practical. Task scope defines the goal, not a restriction on files or components you may change. Fix any code necessary for current acceptance; TL triages independent issues. For a defect owned by this same task, use the normal NOT_PASS/repair loop rather than creating unnecessary cross-scope work.",
    ].join('\n');
  }
  if (role === 'test_engineer') return TEST_ENGINEER_PROMPT;
  if (role === 'tester') {
    return [
      "YOUR ROLE: TESTER. Execute only the Test Engineer's approved testPlan from the most recent test_engineer PASS in task history.",
      "Before running, check each planned entry exists and the executable scope matches the task. Never expand the test selection or run an ALL/full-campaign entry for a narrow task.",
      "Run every selected case and every newly authored/repaired relevant test. Do not edit test or product code. If a plan is missing, stale, or incorrect, return NOT_PASS with result.testPlanInvalid=true and concrete feedback so Scheduler routes to Test Engineer.",
      "Use fresh execution evidence for each acceptance criterion and required interface. Reuse fresh task-specific automated CI results when applicable; historical integration results alone are insufficient.",
      "Return criterion-level statuses and the REQUIRED result.interfaceVerifications (one entry per verified interface; get any anchors from the ariad_anchor_lookup tool, never from memory), and report independent defects through ariad_report_issue. A product failure is NOT_PASS and follows Developer repair; never silently broaden scope.",
    ].join('\n');
  }
  if (role === 'reviewer') {
    return [
      "YOUR ROLE: REVIEWER",
      CODE_NAVIGATION_PROMPT,
      "Review the completed task as an evidence chain: task ownership -> required interface contract -> implementation realization -> Tester verification -> acceptance criteria.",
      "If and only if the review will PASS, finalize source control before ariad_role_result: use bash only for git status/diff/add/commit/push, stage only the reviewed product code/data/tests/assets for this delivery, commit them with a concise task-specific message, and push the current branch. Never stage runtime/generated state such as .ariad/state.db, .ariad/pi, .ariad/artifacts/task-context, or .godot. Do not use bash to run tests, edit files, or perform unrelated shell work. If source-control finalization fails, do not claim a clean PASS; report the failure explicitly.",
      "Do not redo repository-wide discovery or repeat Tester work unless evidence is contradictory or insufficient.",
      "For every required interface, check that the implementation is appropriate for the owning Feature and abstraction level, the realization plausibly corresponds to the contract, and Tester evidence exercises the important inputs, outputs, and sideEffects.",
      "For Providers, require evidence for both provider creation and behavior of the produced thing.",
      "Reject missing links, prose-only claims where executable evidence should exist, silent semantic interface changes, and integration code owned at the wrong Feature or Milestone level.",
      "result.interfaceReviews is REQUIRED in every result. For PASS, return one entry per required interface as [{interfaceId,status:\"APPROVED\",reason}]; when not approving, return an empty array rather than omitting the field. Ariad independently checks the realization and Tester verification chain before accepting the review.",
      "PASS only when contract, implementation, evidence, and acceptance criteria agree. On NOT_PASS identify the exact broken interface/evidence link.",
      "When review discovers an out-of-scope defect, call ariad_report_issue immediately once evidence is concrete; it is non-terminal and begins Tech Lead triage while review may continue. Judge this task against its own acceptance criteria; TL determines whether an independent issue blocks other deliverables. and include it in result.discoveredIssues as fallback/final record when practical. Ordinary defects owned by the reviewed task should remain NOT_PASS feedback to that task rather than unnecessary cross-scope issue work.",
    ].join('\n');
  }
  return null;
}

export function plannerPublicPlan(plan) {
  if (!plan) return null;
  const { executionTasks, ...publicPlan } = plan;
  return publicPlan;
}

export function plannerPrompt({ store, project, task, artifactRoot }) {
  const purpose = task.input?.purpose;
  const currentPlan = plannerPublicPlan(latestPlanInFlow(store, task, artifactRoot));
  const context = {
    project: {
      id: project.id,
      spec: project.spec ?? null,
      mode: project.mode ?? 'NEW',
      sourcePath: project.sourcePath ?? null,
      deliveryPlanSummary: project.deliveryPlanSummary ?? null,
      projectVersion: project.projectVersion ?? 0,
      activeVersion: project.activeVersion ?? 1,
    },
    planningRequests: task.input?.requests ?? [],
    currentDeliveryPlan: currentPlan,
  };

  if (purpose === 'PLANNER_DECOMPOSE') {
    const nodeType = task.input?.frontierPhase ?? 'feature';
    const issueRequests = (task.input?.requests ?? []).filter(item => item?.request?.purpose === 'TRIAGE_AND_ASSIGN_ISSUE');
    const frontier = beginFrontierPass(artifactRoot, nodeType);
    return [
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      issueRequests.length ? [
        'ISSUE TRIAGE / ASSIGNMENT',
        'One or more planning requests are issues. Triage each against current repository reality and feature/interface ownership before changing the plan.',
        'Reject duplicates/non-defects by leaving delivery unchanged and documenting the disposition in planning artifacts/history.',
        'For a valid issue, assign repair to the correct existing owning Feature/interface when possible; revise boundaries only when ownership is genuinely missing or wrong.',
        'Create or update the smallest bounded delivery repair task. Preserve issueRefs:[issueId] on every delivery task created specifically to resolve that issue so Ariad can track assignment.',
        'Make the assignment by patching artifacts with ariad_planner_patch (add the repair task, then updateItem addToList dependsOn where a gate must wait for it). Never edit planner JSON files directly.',
        'The reporting task is NOT automatically blocked. Judge whether a later READY task or integration gate must depend on the fix; if the source task is WORKING or already completed, do not mutate it. Do not request a pause: PM alone decides stopping policy.',
        JSON.stringify({ issueRequests }, null, 2),
      ].join('\n\n') : null,
      frontierArtifactInstructions(artifactRoot, nodeType),
      nodeType === 'feature'
        ? 'FEATURE FRONTIER PHASE: define product/behavior decomposition, boundary contracts, and the canonical implementation/local-test tasks owned by every node created or finalized in this round. Do not defer task intent to a later global pass.'
        : 'MILESTONE FRONTIER PHASE: define delivery/integration decomposition, feature interface uses, additive links to feature tasks, and milestone-owned integration/E2E tasks for every node created or finalized in this round. Do not defer integration test ownership to a later global pass.',
      frontier.bootstrap
        ? frontier.instruction
        : [
            frontier.instruction,
            'The current node already has a parent-facing contract. Preserve every exported interface exactly.',
            'If expanding, define each direct child completely enough to expose its own stable parent-facing contract and decomposition decision.',
            'Then update the current node imports and integrationScenarios so they use only those direct-child exported interfaces.',
          ].join(' '),
      JSON.stringify({
        frontierPhase: nodeType,
        frontier,
      }, null, 2),
      nodeType === 'milestone'
        ? 'Milestone artifacts may keep legacy tasks=[] as a compatibility view; canonical task ownership now lives in the milestone boundary contract (featureUses/taskLinks/integrationTasks).'
        : 'A leaf Feature that requires implementation should own its canonical featureTasks now. A pure composition node may own no implementation task and instead express integrationScenarios.'
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_DEPENDENCIES') {
    const canonicalTasks = hasBoundaryContracts(artifactRoot)
      ? buildOwnedExecutionTasks(artifactRoot)
      : [];
    return [
      'You are Ariad\'s Tech Lead dependency compilation pass.',
      'DO NOT invent, rename, rewrite, broaden, or reinterpret task intent here. Feature and milestone frontier passes already own task definition.',
      'Compile the already-defined canonical featureTasks, milestone taskLinks, and milestone integrationTasks into the legacy milestone/tasks compatibility artifacts and add only precise dependency edges required for execution ordering.',
      'Feature task title, intent, acceptanceCriteria, testStrategy, issueRefs, and feature ownership are immutable in this pass.',
      'Milestone taskLinks may only add dependencies and verification. Milestone integrationTasks are already defined and must remain milestone-owned.',
      'Apply every artifact change with the ariad_planner_patch tool (addItem for new compiled tasks, updateItem with addToList dependsOn for new edges). Do not edit milestone or contract files as text: runtime policy blocks it, and unvalidated text edits are how planner JSON gets corrupted.',
      'Developer owns implementation, system wiring and cheap deterministic __tests__ including mock-based integration CI. Tester owns real-system integration, UI journeys, E2E and regression-only verification in __integration_tests__. Automatic CI selects only current-directory and direct-parent __tests__; no sibling or recursive ancestor sweep.',
      'Logical parentage is semantic only and never creates an execution dependency.',
      'Milestone parentage is execution structure: child milestones complete before parent integration/E2E work. Do not repeat that implicit ordering in dependsOn.',
      'Use milestone dependsOn only for additional prerequisite milestones and task dependsOn only for precise extra task prerequisites.',
      canonicalTasks.length
        ? 'ARIAD CANONICAL TASKS (copy semantics exactly; only compile dependency/milestone placement):\n' + JSON.stringify(canonicalTasks, null, 2)
        : null,
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      plannerArtifactInstructions(artifactRoot),
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_FRONTIER_REPAIR') {
    const previous = predecessorResults(store, task)[0] ?? null;
    const frontier = latestFrontierCompletion(store, task);
    return [
      "You are Ariad's Tech Lead repairing exactly one migration frontier.",
      'Repair only the current frontier artifacts identified below. Do not alter already-frozen ancestor exports or unrelated siblings.',
      'Address only concrete critic issues. Preserve accepted node identity and product intent.',
      JSON.stringify({
        context,
        frontier,
        critic: previous?.result ?? previous ?? null,
      }, null, 2),
      frontierArtifactInstructions(artifactRoot, task.input?.frontierPhase ?? 'feature'),
    ].join('\n\n');
  }

  if (purpose === 'PLANNER_REPAIR') {
    const previous = predecessorResults(store, task)[0]?.result ?? null;
    return [
      'You are Ariad\'s Tech Lead repair pass.',
      'Repair only the affected planner artifacts using the critic findings below. Do not rewrite or re-emit the complete project plan.',
      'Do not add unrelated scope.',
      JSON.stringify({ context, critic: previous }, null, 2),
      plannerArtifactInstructions(artifactRoot),
    ].join('\n\n');
  }

  return buildTechLeadPrompt({ projectContext: context, schema: TECH_LEAD_PLAN_SCHEMA });
}

export function criticPrompt({ store, project, task, artifactRoot }) {
  const validation = predecessorResults(store, task)[0]?.result ?? null;
  if (task.input?.purpose === 'PLANNER_FRONTIER_CRITIC') {
    const frontier = latestFrontierCompletion(store, task);
    return [
      "You are Ariad's semantic critic for exactly one top-down migration frontier.",
      'Review only the frontier just produced, plus the parent contract needed to judge it.',
      'Check: correct abstraction level, interface quality, Executor/Provider semantics where applicable, stable parent boundary, sensible child decomposition, task/interface ownership, and whether the frontier preserves project intent.',
      'Do not request unrelated tree-wide cleanup. Return CLEAN when this frontier is acceptable; otherwise ISSUES with precise, locally repairable findings.',
      JSON.stringify({
        project: { id: project.id, spec: project.spec ?? null },
        frontier,
        validation,
      }, null, 2),
    ].join('\n\n');
  }
  let batchRequests = [];
  let techLeadResults = [];
  try {
    batchRequests = planningBatchRequests(store, task).map(item => ({
      purpose: item.request?.purpose ?? null,
      issueId: item.request?.issueId ?? null,
      title: item.request?.issue?.title ?? null,
    }));
    const siblings = flowTasks(store, task);
    techLeadResults = ['decompose', 'dependencies'].map(name => {
      const sibling = siblings.find(item => item.id?.endsWith(`:${name}`));
      const entry = sibling ? latestRoleResult(sibling) : null;
      return entry ? { stage: name, outcome: entry.outcome ?? null, summary: entry.summary ?? null } : null;
    }).filter(Boolean);
  } catch {
    // Batch context is advisory prompt material; never fail the prompt over it.
    batchRequests = [];
    techLeadResults = [];
  }
  return [
    'You are Ariad\'s delivery-plan critic.',
    'BATCH SCOPE: You are reviewing exactly one planning batch. Its requests and the Tech Lead results for it are included below as batchRequests and techLeadResults.',
    'Review what this batch produced or changed, and its consistency with the surrounding accepted plan. Properties of the pre-existing accepted plan that this batch did not create or modify are out of scope: if you notice such a concern, report it in result.observations only - never in result.issues - and do not let it change your outcome.',
    'Return ISSUES only for defects in this batch\'s own product: a wrong triage or assignment, a broken boundary or dependency change it introduced, or artifacts it wrote.',
    'Review the candidate v2 delivery plan and validator result. Focus on logical-tree quality, milestone structure, project-wide completeness, missing integration/testing responsibility, invalid milestone direction, missing dependencies, over-broad serialization, bad hierarchy, and tasks that are too large.',
    'A plan is incomplete if it only describes the next milestone while known project goals/features clearly continue beyond it. Near-term work may be detailed and later milestones coarse, but the plan must still reach the known project root.',
    'For takeover, explicitly compare authoritative roadmap/milestone/docs against BOTH the logical tree and milestone list. If known major later scope appears in the sources or logical tree but disappears from milestones, return ISSUES. Reject placeholder/unused/TBD milestones that do not represent a real checkpoint.',
    'Submit the critic result through the provider\'s structured role-result mechanism when available. Use outcome CLEAN|MINOR_ONLY|ISSUES and include result.issues plus result.summary. Terminal prose or JSON is NOT a result; if you do not submit through the structured mechanism, the attempt fails.',
    'On round 3, use MINOR_ONLY when only non-blocking polish remains.',
    JSON.stringify({
      project: { id: project.id, spec: project.spec ?? null },
      round: task.input?.round ?? null,
      validation,
      batchRequests,
      techLeadResults,
      plan: plannerPublicPlan(validation?.plan ?? latestPlanInFlow(store, task, artifactRoot)),
    }, null, 2),
  ].join('\n\n');
}
