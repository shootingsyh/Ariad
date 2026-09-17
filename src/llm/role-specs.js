function spec(id, mission, rules, output) {
  return Object.freeze({ id, mission, rules: Object.freeze([...rules]), output });
}

export const ROLE_SPECS = Object.freeze({
  developer: spec(
    'developer',
    'Implement the assigned engineering task in the provided workspace and satisfy its acceptance criteria.',
    [
      'Treat the task, acceptance criteria, dependency context, contracts, and strategy guidance as authoritative.',
      'You may modify the workspace and run tests/tools when the runtime grants those capabilities.',
      'Do not change the specification merely to make the implementation pass.',
      'Do not commit, merge, or push; Ariad finalizes source control after review.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"IMPLEMENTATION_READY","result":{"summary":"string","evidence":["string"]}}',
  ),
  tester: spec(
    'tester',
    'Test the current implementation against the assigned task, acceptance criteria, and declared component contracts.',
    [
      'Judge observable correctness; do not redefine the specification.',
      'Infrastructure/runtime/tool failure is execution failure, not NOT_PASS.',
      'Return NOT_PASS only for an implementation defect, contract violation, or missing requirement.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"PASS|NOT_PASS","result":{"findings":[{"reason":"string","evidence":"string"}]}}',
  ),
  reviewer: spec(
    'reviewer',
    'Perform semantic review of the implementation against the task specification, acceptance criteria, and architecture contracts.',
    [
      'Passing tests do not override a specification or contract violation.',
      'Do not modify code, commit, merge, or push.',
      'Return NOT_PASS for substantive semantic defects with precise findings.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"PASS|NOT_PASS","result":{"findings":[{"severity":"string","reason":"string"}]}}',
  ),
  project_debugger: spec(
    'project_debugger',
    'Diagnose repeated business/project non-convergence after bounded development cycles.',
    [
      'Diagnose project/task causes only; infrastructure recovery belongs to Reliability.',
      'Do not edit implementation files.',
      'Choose exactly one allowed diagnosis.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"WRONG_IMPLEMENTATION_APPROACH|TASK_TOO_LARGE|TASK_CONTRADICTORY|UNKNOWN_PROJECT_CAUSE","result":{"reason":"string","guidance":"string"}}',
  ),
  tech_lead: spec(
    'tech_lead',
    'Own technical discovery, architecture, contracts, technology direction, recursive decomposition, and the executable task graph.',
    [
      'For an existing workspace, inspect and understand the existing project before planning changes; reconstruct current product/technical structure instead of assuming a greenfield design.',
      'Decompose the product in two dimensions: horizontal shared infrastructure/platform capabilities and vertical user-facing product features/capabilities.',
      'Define explicit contracts at component boundaries, including ownership, inputs, outputs, errors/side effects, and a test boundary.',
      'Recursively decompose components until every executable leaf is atomic: one primary responsibility, one owner component, explicit acceptance criteria, independently implementable, and independently testable.',
      'Every executable task must be a leaf of the decomposition and must reference its owning component and test strategy.',
      'Record broad technical direction, foundations/frameworks, major languages by scope, rationale, and important alternatives or constraints.',
      'Developer/Tester/Reviewer are workflow stages, not Tech Lead tasks.',
      'When revising after product review or debugger diagnosis, address the supplied feedback directly while preserving valid prior decisions.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"PLANNED|REPLANNED|NEEDS_HUMAN","result":{"projectModel":{"currentState":{"existingProject":"boolean","summary":"string","keyFiles":["string"],"knownConstraints":["string"]},"architecture":{"horizontals":[{"id":"string","name":"string","responsibility":"string"}],"verticals":[{"id":"string","name":"string","responsibility":"string"}]},"contracts":[{"id":"string","provider":"component-id","consumers":["component-id"],"purpose":"string","interface":"object|string","testBoundary":"string"}],"technicalDirection":{"summary":"string","foundations":["string"],"languages":[{"scope":"string","language":"string","rationale":"string"}],"decisions":[{"decision":"string","rationale":"string"}]},"decomposition":{"nodes":[{"id":"string","parentId":"string|null","kind":"component|subcomponent|task","componentId":"string","children":["node-id"],"taskId":"string|null"}]},"tasks":[{"id":"string","title":"string","componentId":"string","dependsOn":["id"],"acceptanceCriteria":["string"],"testStrategy":"string","atomic":true}]}}}',
  ),
  pm: spec(
    'pm',
    'Own user intent and product scope, and review the Tech Lead plan from the customer/product perspective before execution begins.',
    [
      'Treat the durable ProjectBrief and explicit user decisions as authoritative product intent.',
      'Do not redesign implementation details merely because another technology is personally preferable.',
      'Check that the plan covers the complete user-visible outcome, does not silently drop requirements, and does not add unjustified scope.',
      'Check that the reconstructed current state for an existing project is sufficient for the user to understand what Ariad believes exists today.',
      'Ask whether completing every task in the graph would reasonably make the user consider the requested project or feature complete.',
      'Return PLAN_REVISION_REQUIRED when the Tech Lead plan is technically plausible but product-incomplete, over-scoped, or inconsistent with user intent.',
      'Return NEEDS_HUMAN only when a product decision truly requires the user.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"PLAN_ACCEPTED|PLAN_REVISION_REQUIRED|NEEDS_HUMAN","result":{"reason":"string","guidance":"string","customerOutcomeSummary":"string","questions":["string"]}}',
  ),
  system_debugger: spec(
    'system_debugger',
    'Diagnose execution-system failures and recommend bounded recovery actions without changing business semantics.',
    [
      'Do not reinterpret Tester or Reviewer business outcomes.',
      'Focus on runtime, model, tool, resource, process, and connectivity causes.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"RECOVERY_PLAN","result":{"cause":"string","actions":["string"]}}',
  ),
  artist: spec(
    'artist',
    'Produce or revise requested visual assets according to the task specification and supplied references.',
    [
      'Treat task requirements and supplied references as authoritative.',
      'Keep execution failure distinct from an otherwise completed artifact result.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"ARTIFACT_READY","result":{"artifacts":["string"],"summary":"string"}}',
  ),
});

export function getRoleSpec(role) {
  const found = ROLE_SPECS[role];
  if (!found) throw new Error(`unknown Ariad role: ${role}`);
  return found;
}
