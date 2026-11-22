import { acceptanceCriterionIdsFor } from './task-context-artifact.js';

// Resolve the required criterion IDs for test-plan coverage from the
// role context's task view. Callers (default-roles prepareLlm) already
// derive acceptanceCriterionIds; when that field is absent or empty but
// the task spec defines acceptance criteria, derive the same stable
// AC1..ACn IDs from the criteria themselves instead of reporting
// "Allowed: []" (SRPG T-fix-battlefield-location-routing, 2026-11-22).
export function resolveRequiredCriterionIds(taskContext = {}) {
  const explicit = taskContext?.acceptanceCriterionIds;
  if (Array.isArray(explicit) && explicit.length > 0) return [...explicit];
  return acceptanceCriterionIdsFor(taskContext?.acceptanceCriteria);
}

// Deterministic test-plan coverage check: every testCase.covers entry must
// be one of the task's acceptanceCriterionIds, and every required ID must
// be covered by at least one test case. Throws ARIAD_TEST_PLAN_COVERAGE_INVALID
// with the allowed/invalid/missing breakdown otherwise.
export function validateTestPlanCoverage(taskContext = {}, testCases) {
  const required = resolveRequiredCriterionIds(taskContext);
  const cases = Array.isArray(testCases) ? testCases : [];
  const invalid = cases.flatMap(c => (Array.isArray(c?.covers) ? c.covers : []).filter(id => !required.includes(id)));
  const missing = required.filter(id => !cases.some(c => Array.isArray(c?.covers) && c.covers.includes(id)));
  if (!cases.length || invalid.length > 0 || missing.length > 0) {
    const error = new Error(
      'ARIAD_TEST_PLAN_COVERAGE_INVALID: covers must reference exact acceptanceCriterionIds. '
      + `Allowed: ${JSON.stringify(required)}; invalid: ${JSON.stringify(invalid)}; missing: ${JSON.stringify(missing)}`,
    );
    error.code = 'ARIAD_TEST_PLAN_COVERAGE_INVALID';
    error.required = required;
    error.invalid = invalid;
    error.missing = missing;
    throw error;
  }
  return { required, cases: cases.length };
}
