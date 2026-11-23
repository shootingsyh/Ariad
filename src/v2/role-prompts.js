/** Role prompt fragments and planner/critic prompt builders,
 * extracted from default-roles.js. */
import { acceptanceCriterionIds } from './acceptance.js';
import { buildTechLeadPrompt } from './tech-lead-prompt.js';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { flowTasks, latestRoleResult, planningBatchRequests, predecessorResults } from './planning-helpers.js';
import { VersionedStore } from './versioned-store.js';
import { derivedSweepAccounting } from './sweep-accounting.js';

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
  "Tag every full-journey case with the reserved executionScope tag 'full-journey'. A full-journey case traverses the whole product end to end (for example a packaged-app end-to-end run or a whole-campaign playthrough) instead of only the surfaces this task changes. Full-journey cases are reserved for integration and release tasks: their verdict expires with every later change still queued behind this task. For any other task, cover each criterion with scope-limited leaf/integration cases; the plan validator rejects a plan containing a 'full-journey' case and returns it to you for revision. You may still follow the full journey's shape in a case for any task, but everything outside this task's own scope must be mocked and the real application process must never be launched for those out-of-scope parts; a case executed that way is scope-limited, so do not tag it 'full-journey' - the tag is only for cases that really execute the whole product end to end.",
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

// Plan payload for reviewers (owner design, 2026-11-22): validator
// results carry only a stub (version + diffHash) - the plan itself
// lives in the versioned store, never archived inside a task. Prompt
// builders assemble the full payload (tasks, contracts, diff, derived
// sweep accounting) from the store at dispatch time, so the critic
// and the PM still judge the complete draft text (the 2026-11-01
// lesson) without every validator task warehousing another copy of
// the tree. Legacy results that still embed the plan are used as-is.
export function planPayloadFromStore(store, project, validation) {
  const stub = validation?.plan ?? null;
  if (!stub) return null;
  if (Array.isArray(stub.tasks)) return stub;
  if (stub.version == null) return stub;
  let vs = null;
  try {
    vs = new VersionedStore(store.filePath ?? join(project.workspace, '.ariad', 'state.db'));
    const tasks = vs.listSpecTasks(stub.version);
    const contracts = vs.listSpecContracts(stub.version);
    let diff = null;
    let sweepAccounting = null;
    const open = vs.getOpenDraft();
    if (open?.version === stub.version) {
      diff = vs.diffDraft();
      const baseTaskIds = open.base_version != null
        ? vs.listSpecTasks(open.base_version).map(t => t.id).filter(Boolean)
        : [];
      sweepAccounting = { derived: true, entries: derivedSweepAccounting(diff, baseTaskIds) };
    }
    // Owner design, 2026-11-22 (later the same day): reviewers judge
    // the diff, not the tree - the payload carries the diff and the
    // derived sweep accounting, never another copy of the full draft.
    // The complete draft text is written to a file in the project
    // workspace and named as planFile; a reviewer that needs an
    // unchanged task's full text, or a changed task's context beyond
    // the diff's capped values, reads it there.
    let planFile = null;
    try {
      planFile = `.ariad/artifacts/planning/draft-v${stub.version}.json`;
      mkdirSync(join(project.workspace, '.ariad', 'artifacts', 'planning'), { recursive: true });
      writeFileSync(join(project.workspace, planFile), JSON.stringify({ version: stub.version, tasks, contracts }, null, 2));
    } catch {
      planFile = null;
    }
    return {
      ...stub,
      taskCount: tasks.length,
      contractCount: contracts.length,
      diff,
      sweepAccounting,
      planFile,
    };
  } catch {
    return stub;
  } finally {
    vs?.close();
  }
}

// SWEEP ACCOUNTING mandate, shared verbatim by the decompose and
// repair prompts: the deterministic validator judges the batch by its
// LAST Tech Lead result, so both passes must state the identical rule.
// The two copies once drifted (only the repair copy warned that the
// accounting must sit at the result's top level), and batches 53-55
// sank on exactly that difference.
export const SWEEP_ACCOUNTING_MANDATE = 'SWEEP ACCOUNTING IS DERIVED, NOT AUTHORED: do not include a sweepAccounting in your result. The system computes the accounting from your draft\'s diff against the base version - every pre-existing task you patch is recorded revised with the fields you changed, every task you remove is recorded retired, and every task you leave untouched is recorded non-conflicting. Before submitting, run the ariad_tree_patch diff action and read it as the reviewers will: if this batch was opened to change something, that change must be visible in the diff, and no field of an existing task may drop out of it unless the batch purpose calls for exactly that.';

export function plannerPrompt({ store, project, task, artifactRoot }) {
  const purpose = task.input?.purpose;
  // Inherited human decisions (parity with the PM review payload): a
  // decision recorded on any of this project's tasks binds planning,
  // and the Tech Lead must be able to check request guidance that
  // quotes a decision against the decisions actually recorded - a
  // later decision supersedes the one a request quotes.
  const inheritedHumanDecisions = [];
  try {
    if (typeof store?.listHumanDecisions === 'function') {
      inheritedHumanDecisions.push(...store.listHumanDecisions(project.id));
    }
    inheritedHumanDecisions.sort((x, y) => String(x.at ?? '').localeCompare(String(y.at ?? '')));
  } catch {
    inheritedHumanDecisions.length = 0;
  }
  const currentPlan = null; // DB-first: the plan lives in the DB draft; the TL reads it via ariad_tree_patch.
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
    humanDecisions: inheritedHumanDecisions,
    currentDeliveryPlan: currentPlan,
  };

  if (purpose === 'PLANNER_FEATURES_FUNCTIONAL') {
    return [
      'You are the Tech Lead for Ariad, running feature pass 1 of 3: FUNCTIONAL FEATURES.',
      'The planning work is split into three passes (owner decision, 2026-11-01): this pass authors the functional feature tree and its documents; pass 2 adds the non-functional features; pass 3 refines the interfaces and authors the milestone task tree. A critic reviews each pass, and the PM reviews the complete plan once at the end. Do only this pass.',
      'Work top-down from the human-approved requirements document (.ariad/docs/REQUIREMENTS.md): the top-level functional features align with the structure of that document, and every lower feature refines exactly one parent feature.',
      'Refine each functional feature until it is unambiguous: a leaf feature carries behavior clauses at tester-decidable granularity - states, action order, preconditions, and exception and silent-failure behavior.',
      'SUPPORTS DECLARATIONS (plain text in the documents; there is no separate schema for this): every feature document you write or update (.ariad/docs/features/<nodeId>.md) must carry a Supports line. A root feature names the requirements section or direction it supports (for example: Supports: REQUIREMENTS section 5, Presentation and art). A child feature names the parent feature it supports and refines. A feature that supports nothing is not a feature - do not author one.',
      'Documents move before the database: write or update the feature document and the .ariad/docs/FEATURES.md index entry for every feature you add or change, then land the contract ops with ariad_tree_patch (openDraft, then applyOps).',
      'Do NOT author or change task-tree entries in this pass, do NOT add non-functional features (infrastructure, environment, build, packaging, compilation, test scaffolding) yet - that is pass 2 - and do NOT refine exportedInterfaces beyond what a contract needs to be structurally valid - interfaces are pass 3.',
      'Your submitted result must carry the SUPPORTS ACCOUNTING: one line per feature you added or changed, naming the feature and what it supports, plus the final ariad_tree_patch diff output.',
      buildTechLeadPrompt({ projectContext: context, schema: null }),
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_FEATURES_NONFUNCTIONAL') {
    return [
      'You are the Tech Lead for Ariad, running feature pass 2 of 3: NON-FUNCTIONAL FEATURES.',
      'Pass 1 (the functional feature tree and its documents) is already in the open draft and has been critic-reviewed. Grow the same tree with the non-functional features the product genuinely needs: infrastructure, runtime environment, build and packaging, compilation, test infrastructure and harnesses, tooling, platform support. Add only what the product needs; ceremony is not a feature.',
      'A non-functional feature is a feature contract plus a feature document, like any other feature. Its document must carry a Supports line naming the functional feature it serves (for example: Supports: battle-core (functional feature)). A non-functional feature that serves no named functional feature does not belong in the tree.',
      'Do NOT re-author functional features in this pass - if you spot a genuine defect in one, report it in your result instead. Do NOT author task-tree entries and do NOT refine interfaces - those are pass 3.',
      'Documents move before the database: feature document and .ariad/docs/FEATURES.md index entry for every feature you add or change, then the contract ops with ariad_tree_patch.',
      'Your submitted result must carry the SUPPORTS ACCOUNTING for this pass: one line per non-functional feature, naming the feature and the functional feature it serves, plus the final ariad_tree_patch diff output.',
      buildTechLeadPrompt({ projectContext: context, schema: null }),
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_DECOMPOSE') {
    const issueRequests = (task.input?.requests ?? []).filter(item => item?.request?.purpose === 'TRIAGE_AND_ASSIGN_ISSUE');
    const replanRequests = (task.input?.requests ?? []).filter(item => item?.request?.purpose === 'LOCAL_REPLAN');
    const revisionRequests = (task.input?.requests ?? []).filter(item => item?.request?.purpose === 'PM_PLAN_REVISION');
    return [
      buildTechLeadPrompt({ projectContext: context, schema: null }),
      task.input?.threePass ? 'FEATURE PASS 3 OF 3 - INTERFACES AND TASKS: passes 1 and 2 already authored the functional and non-functional feature tree with documents, and a critic reviewed each pass. Do NOT re-author the feature tree in this pass, except to repair a concrete defect you can name. Your work now: (1) refine every leaf feature contract to final form - exportedInterfaces plus behavior clauses at tester-decidable granularity; (2) author the milestone task tree referencing the features (FEATURE_TASK and INTEGRATION_TASK carry featureId, MILESTONE_TASK never does), including the tasks that build or verify the non-functional features; (3) keep the feature documents, the FEATURES.md index and the Supports declarations consistent with any contract you touch.' : null,
      issueRequests.length ? [
        'ISSUE TRIAGE / ASSIGNMENT',
        'One or more planning requests are issues. Triage each against current repository reality and feature/interface ownership before changing the plan.',
        'Reject duplicates/non-defects by leaving delivery unchanged and documenting the disposition in the issue record.',
        'For a valid issue, route the repair through the issue queue with ariad_insert_fix_task (the fix task runs ahead of milestone work; it does not join the task tree). Only when the fix genuinely changes the planned tree itself, reflect it in the open draft with ariad_tree_patch.',
        'Your result must carry result.issueDispositions: one entry per triaged issue, naming assignedTaskIds for every issue you assign. The deterministic plan validator verifies each claimed ID against the draft and the project\'s live tasks (ISSUE_ASSIGNMENT_UNVERIFIED): a task you claim but did not actually create fails validation and returns the batch to you.',
        'The reporting task is NOT automatically blocked. Do not request a pause: PM alone decides stopping policy.',
        JSON.stringify({ issueRequests }, null, 2),
      ].join('\n\n') : null,
      replanRequests.length ? [
        'LOCAL REPLAN (PROJECT-OWNER DECISION)',
        'One or more planning requests are project-owner decisions to actualize as a bounded change to the current plan; each request carries its own guidance in its guidance field - follow it. Make the smallest correct change and leave every unrelated part of the plan untouched. A pre-existing task whose text conflicts with a decision in this batch is not unrelated: it belongs to the EXISTING TASK SWEEP below.',
        JSON.stringify({ replanRequests }, null, 2),
      ].join('\n\n') : null,
      revisionRequests.length ? [
        'PM PLAN REVISION (CONTINUE THE REJECTED DRAFT AS A NEW VERSION)',
        'The PM rejected the previous plan draft; the requests below carry its full review: reason is the fidelity trace naming exactly which clauses failed, guidance is the repair list. The rejected draft (see rejectedDraftVersion in each request) is still open in the database. FIRST call ariad_tree_patch openRevisionDraft: it closes the rejected draft as superseded (content retained) and opens the NEXT version seeded from it - that new version is your working draft; apply the repairs to it with applyOps. NEVER call discardDraft and NEVER open a fresh draft from prod in this batch - a fresh draft is re-derived from prod and silently drops every fix already landed in the rejected draft, which is exactly what made earlier revision rounds fail to converge. If openRevisionDraft answers NOT_A_REVISION_BASE, the revision draft for this batch is already open: continue that one with applyOps.',
        'Apply only the listed repairs. Every part of the draft the PM did not flag stays exactly as it is. Where the PM quotes required wording, paste it character-for-character - never paraphrase, merge, or reword a quoted clause. After applyOps, re-read the tasks you touched from the draft and confirm every quoted clause is present character-for-character before submitting: a summary claiming a fix is not evidence, the draft text is. If a clause is missing or altered after your writes, fix it in this pass before submitting.',
        'DECISION CHECK: where the review or its guidance quotes or paraphrases a human decision, verify the quote against humanDecisions in the payload - every human decision recorded on this project, in time order. A decision recorded later than the review governs, even if the review calls its own quote the latest; and a requirement carried by the approved document stays in force until an authoring task changes the document and a human approves the new hash. Revision rounds are capped: after the cap the batch escalates to a human instead of replanning again, so land the complete repair in this pass.',
        JSON.stringify({ revisionRequests }, null, 2),
      ].join('\n\n') : null,
      'EXISTING TASK SWEEP (MANDATORY WHEN THIS BATCH CARRIES NEW OR CHANGED REQUIREMENTS): owner decisions, a requirements delta, or PM revision guidance that changes what the product must be all trigger this sweep. Read the full existing task list in the open draft - not only the tasks you are adding - and check every pre-existing task against the new requirements. A pre-existing task whose intent, acceptanceCriteria, or testStrategy conflicts with, duplicates, or is superseded by the new requirements is in scope for this batch, however unrelated it looks: revise its text to the new requirements in this same draft, retire or merge it, or explicitly re-scope it to the part that remains valid. Never leave a stale task standing beside new work that contradicts it, and never gate new-requirement work behind a stale task whose own acceptance criteria embody the superseded requirement: restructure the dependency so the new work is not blocked on completing and accepting the old construction first. Respect the promotion rules for tasks that have already started: what cannot be revised or removed there, flag explicitly in your result with a proposed disposition instead of leaving it silently stale.',
      SWEEP_ACCOUNTING_MANDATE,
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_DEPENDENCIES') {
    return [
      'You are Ariad\'s Tech Lead dependency compilation pass.',
      'DO NOT invent, rename, rewrite, broaden, or reinterpret task intent here. The decomposition pass already owns task definition in the open database draft.',
      'This is a DB-first project: the plan lives in the database draft, not in planner artifact files. Compile dependencies directly into the draft with the ariad_tree_patch tool (read the draft tasks, then applyOps updateTask to set dependsOn). Do not create or edit planner artifact files.',
      'Feature task title, intent, acceptanceCriteria, testStrategy, issueRefs, and feature ownership are immutable in this pass; only dependency edges (dependsOn) and milestone placement may change.',
      'Logical parentage is semantic only and never creates an execution dependency.',
      'Milestone parentage is execution structure: child milestones complete before parent integration/E2E work. Do not repeat that implicit ordering in dependsOn.',
      'Use milestone dependsOn only for additional prerequisite milestones and task dependsOn only for precise extra task prerequisites.',
      buildTechLeadPrompt({ projectContext: context, schema: null }),
    ].filter(Boolean).join('\n\n');
  }

  if (purpose === 'PLANNER_REPAIR_FEATURES') {
    const previous = predecessorResults(store, task)[0]?.result ?? null;
    const phaseName = task.input?.phase === 'nonfunctional' ? 'non-functional' : 'functional';
    return [
      'You are the Tech Lead for Ariad, repairing the ' + phaseName + ' feature pass.',
      'The critic reviewed that pass and returned the findings below. Repair only the affected feature contracts and feature documents in the open database draft, using ariad_tree_patch applyOps and your document tools. Do not rewrite the whole feature tree, do not touch the other pass, and do not add unrelated scope.',
      'Keep the Supports declarations and the FEATURES.md index consistent with every contract you touch.',
      JSON.stringify({ context, critic: previous }, null, 2),
      buildTechLeadPrompt({ projectContext: context, schema: null }),
    ].join('\n\n');
  }

  if (purpose === 'PLANNER_REPAIR') {
    const previous = predecessorResults(store, task)[0]?.result ?? null;
    const repairRevisionRequests = (task.input?.requests ?? []).filter(item => item?.request?.purpose === 'PM_PLAN_REVISION');
    // Sweep accounting is derived from the draft diff (2026-11-22):
    // repair passes no longer carry an authored accounting forward -
    // the system recomputes it from the diff at validation time.
    return [
      'You are Ariad\'s Tech Lead repair pass.',
      'Repair only the affected parts of the open database draft using the critic findings below, with ariad_tree_patch applyOps. Do not rewrite or re-emit the complete project plan.',
      'Do not add unrelated scope.',
      SWEEP_ACCOUNTING_MANDATE,
      repairRevisionRequests.length ? [
        'VERBATIM-PROTECTED STRINGS (PM PLAN REVISION)',
        'This batch continues a PM-rejected draft. The PM revision review in this batch requests quotes required wording and lists (acceptance clauses, media and deliverable names) character-for-character. Those quoted strings are protected: never paraphrase, merge, split, rename, or drop them, and never let a critic finding rewrite them. Repair structural defects around them - malformed shells, missing parents, broken hierarchy - never through them. If a critic finding asks you to change a quoted clause or list, treat that finding as out of scope and leave the quoted text untouched.',
        JSON.stringify({ revisionRequests: repairRevisionRequests }, null, 2),
      ].join('\n\n') : null,

      JSON.stringify({ context, critic: previous }, null, 2),
      buildTechLeadPrompt({ projectContext: context, schema: null }),
    ].filter(Boolean).join('\n\n');
  }

  return buildTechLeadPrompt({ projectContext: context, schema: null });
}

export function criticPrompt({ store, project, task, artifactRoot }) {
  const validation = predecessorResults(store, task)[0]?.result ?? null;
  if (task.input?.purpose === 'PLANNER_CRITIC_FEATURES') {
    const phase = task.input?.phase === 'nonfunctional' ? 'nonfunctional' : 'functional';
    const shared = [
      'Return ISSUES only for defects in this pass. Pre-existing plan content this pass did not create or change is out of scope: report such concerns in result.observations only.',
      'Submit the critic result through the structured role-result mechanism when available. Use outcome CLEAN|MINOR_ONLY|ISSUES and include result.issues plus result.summary. Use MINOR_ONLY when only non-blocking polish remains. Terminal prose or JSON is NOT a result.',
    ];
    const lines = phase === 'functional' ? [
      'You are the delivery-plan critic for Ariad, reviewing feature pass 1 of 3 (functional features) - this pass only, not the whole plan.',
      'The Tech Lead authored or revised the functional feature contracts and their documents in the open DB draft; the deterministic phase validation result and the contracts diff against the production version are in the payload. The full current contract list is not embedded: it is in the file named by plan.planFile in the payload - read it when you need the whole tree. There is deliberately no task tree and no interface refinement yet - those are later passes - so their absence is not an issue.',
      'Judge this pass on five things. (1) ALIGNMENT: the top-level features track the structure of the approved requirements document (.ariad/docs/REQUIREMENTS.md - read it), and every lower feature refines exactly one parent feature. (2) SUPPORTS: every feature document states what the feature supports - a root feature names the requirements section or direction, a child feature names its parent. Read the documents under .ariad/docs/features/; a feature without a Supports declaration, or one naming nothing real, is an ISSUE. (3) NO AMBIGUITY: leaf behavior clauses sit at tester-decidable granularity - states, action order, preconditions, exception and silent-failure behavior; a leaf defined by a vague verb alone is an ISSUE. (4) PURITY: no non-functional features (infrastructure, environment, build, packaging, test scaffolding) and no task-tree work in this pass. (5) DOCUMENTS: every added or changed feature has its document and a FEATURES.md index entry.',
      'Fidelity granularity applies at this pass too: an enumerated requirement clause buried in the middle of a paragraph still needs a carrying feature; headline-level coverage of a clause-list section is an ISSUE.',
      ...shared,
    ] : [
      'You are the delivery-plan critic for Ariad, reviewing feature pass 2 of 3 (non-functional features) - this pass only, not the whole plan.',
      'The functional feature tree (pass 1) is already in the draft and was reviewed; the phase validation result and the contracts diff are in the payload, and the full current contract list is in the file named by plan.planFile - read it when you need the whole tree. Judge only what this pass added or changed.',
      'Judge this pass on four things. (1) SUPPORTS: every non-functional feature document names the functional feature it serves; one that serves nothing named, or names a feature that does not exist in the draft, is an ISSUE. (2) NECESSITY AND PURITY: each non-functional feature is a real product need - infrastructure, environment, build or packaging, compilation, test infrastructure, tooling, platform - not ceremony; and this pass did not re-author functional behavior, task-tree entries, or interfaces. (3) DOCUMENTS: a feature document and a FEATURES.md index entry for every added or changed feature. (4) INTEGRITY: the pass-1 functional tree is intact - no functional contract was silently rewritten or dropped.',
      ...shared,
    ];
    return [
      ...lines,
      JSON.stringify({
        project: { id: project.id, spec: project.spec ?? null },
        phase,
        validation,
        plan: planPayloadFromStore(store, project, validation),
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
      ...(item.request?.purpose === 'PM_PLAN_REVISION' ? {
        rejectedDraftVersion: item.request?.rejectedDraftVersion ?? null,
        reason: item.request?.reason ?? null,
        guidance: item.request?.guidance ?? null,
      } : {}),
    }));
    const siblings = flowTasks(store, task);
    const summarize = (stage, sibling) => {
      const entry = sibling ? latestRoleResult(sibling) : null;
      if (!entry) return null;
      return {
        stage,
        outcome: entry.outcome ?? null,
        summary: entry.summary ?? null,
      };
    };
    techLeadResults = [
      ...['features-functional', 'features-nonfunctional', 'decompose', 'dependencies']
        .map(name => summarize(name, siblings.find(item => item.id?.endsWith(`:${name}`)))),
      ...siblings
        .filter(item => /:repair-\d+$/.test(item.id ?? ''))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map(sibling => summarize(String(sibling.id).split(':').pop(), sibling)),
    ].filter(Boolean);
  } catch {
    // Batch context is advisory prompt material; never fail the prompt over it.
    batchRequests = [];
    techLeadResults = [];
  }
  // Plan diff + derived sweep accounting are assembled from the
  // store by planPayloadFromStore (owner design, 2026-11-22): the
  // validator result names the draft version and the diffHash; the
  // payload content is loaded from the draft itself, never archived
  // in the validator task, so it cannot be lost between passes.
  // The payload carries the diff only; the full draft text is in
  // the workspace file named by planFile, for on-demand reading.
  const planPayload = planPayloadFromStore(store, project, validation);
  const sweepAccounting = planPayload?.sweepAccounting ?? null;
  const planDiff = planPayload?.diff ?? null;
  return [
    'You are Ariad\'s delivery-plan critic.',
    'BATCH SCOPE: You are reviewing exactly one planning batch. Its requests and the Tech Lead results for it are included below as batchRequests and techLeadResults.',
    'PLAN DIFF AND SWEEP ACCOUNTING: the payload planDiff is the system-computed diff of the draft against the production version (added / removed / changed, with field-level from/to detail), and sweepAccounting is derived from that diff - every pre-existing task is accounted for by construction, so never report it missing. Judge the diff against this batch\'s purpose: a batch opened to change something whose diff does not contain the change is an ISSUE, and a change that silently drops or empties a field of an existing task (acceptanceCriteria, testStrategy, dependsOn) is an ISSUE - name the task and the field.',
    'Review what this batch produced or changed, and its consistency with the surrounding accepted plan. Properties of the pre-existing accepted plan that this batch did not create or modify are out of scope: if you notice such a concern, report it in result.observations only - never in result.issues - and do not let it change your outcome.',
    'Return ISSUES only for defects in this batch\'s own product: a wrong triage or assignment, a broken boundary or dependency change it introduced, or artifacts it wrote.',
    'Review the candidate v2 delivery plan and validator result. Focus on logical-tree quality, milestone structure, project-wide completeness, missing integration/testing responsibility, invalid milestone direction, missing dependencies, over-broad serialization, bad hierarchy, and tasks that are too large.',
    'A plan is incomplete if it only describes the next milestone while known project goals/features clearly continue beyond it. Near-term work may be detailed and later milestones coarse, but the plan must still reach the known project root.',
    'For takeover, explicitly compare authoritative roadmap/milestone/docs against BOTH the logical tree and milestone list. If known major later scope appears in the sources or logical tree but disappears from milestones, return ISSUES. Reject placeholder/unused/TBD milestones that do not represent a real checkpoint.',
    'FIDELITY TO THE APPROVED REQUIREMENTS: read .ariad/docs/REQUIREMENTS.md - above all its delta - and compare it against the plan diff in the payload (planDiff / plan.diff): every addition or change this batch makes is there with field-level from/to. The full draft text is in the file named by plan.planFile - read it when a requirement is carried by an unchanged task or you need the full context of a changed task beyond the diff. Return ISSUES when a delta addition or change is carried only by verification or regression tasks with no production task and no concrete existing evidence; when an enumerated requirement is diluted into generic acceptance language or covered only in part (a list covered only in part is not covered); or when a visual or media gap has no concrete art task with named deliverables, or visual tasks lack ux.required. The gap-analysis disposition in the Tech Lead result is part of what you review: a missing disposition, or one that rests on asset names and counts alone for enumerated qualities, is an ISSUE. Granularity is part of fidelity: a disposition or acceptance that accounts at section-headline level while the document enumerates individual clauses inside a paragraph (action sets, expression or scar variants, effects lists) is an ISSUE.',
    'VERBATIM FIDELITY: when this batch continues a PM-rejected draft, the PM revision review in batchRequests quotes required wording and lists character-for-character. Those quoted strings are protected: a draft that paraphrases, merges, or drops them fails fidelity even if its structure is clean, and a finding that asks for them to be reworded is out of scope. A critic CLEAN on a draft missing a quoted clause is a missed defect.',
    'SUPPORTS DECLARATIONS: every feature in the draft must declare what it supports, in its feature document - a root functional feature names the requirements section or direction it supports, a child feature names its parent feature, and a non-functional feature names the functional feature it serves. A feature whose document declares no support target, or a non-functional feature serving no named functional feature, is an ISSUE.',
    'TASK TARGETS: a delivery task changes project files only. Return ISSUES for any task in this batch whose deliverable requires a delivery role to modify Ariad-held data - the spec tree, a stored test plan, task records, anything persisted in the project state database. Corrections to such data belong to the Tech Lead, made through ariad_tree_patch in this same batch and carried in the spec of the task that will produce the plan, never delegated to a delivery task.',
    'Submit the critic result through the provider\'s structured role-result mechanism when available. Use outcome CLEAN|MINOR_ONLY|ISSUES and include result.issues plus result.summary. Terminal prose or JSON is NOT a result; if you do not submit through the structured mechanism, the attempt fails.',
    'On round 3, use MINOR_ONLY when only non-blocking polish remains.',
    JSON.stringify({
      project: { id: project.id, spec: project.spec ?? null },
      round: task.input?.round ?? null,
      validation,
      batchRequests,
      techLeadResults,
      sweepAccounting,
      planDiff,
      plan: planPayload,
    }, null, 2),
  ].join('\n\n');
}
