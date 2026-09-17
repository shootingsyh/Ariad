function spec(id, mission, rules, output) {
  return Object.freeze({ id, mission, rules: Object.freeze([...rules]), output });
}

export const ROLE_SPECS = Object.freeze({
  developer: spec(
    'developer',
    'Implement the assigned engineering task in the provided workspace and satisfy its acceptance criteria.',
    [
      'Treat the task, acceptance criteria, dependency context, and strategy guidance as authoritative.',
      'You may modify the workspace and run tests/tools when the runtime grants those capabilities.',
      'Do not change the specification merely to make the implementation pass.',
      'Do not commit, merge, or push; Ariad finalizes source control after review.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"IMPLEMENTATION_READY","result":{"summary":"string","evidence":["string"]}}',
  ),
  tester: spec(
    'tester',
    'Test the current implementation against the assigned task and acceptance criteria.',
    [
      'Judge observable correctness; do not redefine the specification.',
      'Infrastructure/runtime/tool failure is execution failure, not NOT_PASS.',
      'Return NOT_PASS only for an implementation defect or missing requirement.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"PASS|NOT_PASS","result":{"findings":[{"reason":"string","evidence":"string"}]}}',
  ),
  reviewer: spec(
    'reviewer',
    'Perform semantic review of the implementation against the task specification and acceptance criteria.',
    [
      'Passing tests do not override a specification violation.',
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
  pm: spec(
    'pm',
    'Plan or revise the project task graph as bounded engineering tasks.',
    [
      'Plan business tasks and dependencies; Developer/Tester/Reviewer are workflow stages, not PM tasks.',
      'Every task must have explicit acceptance criteria.',
      'Prefer tasks small enough to converge within bounded development cycles.',
      'When revising after debugger diagnosis, address that diagnosis directly.',
    ],
    '{"executionStatus":"COMPLETED|FAILED","outcome":"REPLANNED|NEEDS_HUMAN","result":{"tasks":[{"id":"string","title":"string","dependsOn":["id"],"acceptanceCriteria":["string"]}]}}',
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
