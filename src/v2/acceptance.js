export const CRITERION_STATUSES = Object.freeze([
  'SATISFIED',
  'FAILED',
  'UNVERIFIED',
  'BLOCKED',
]);

// Canonical criteria shape: an array of criterion texts. A task may be
// authored with acceptanceCriteria as a single string (one prose
// criterion) - every consumer derives positional IDs (AC1..ACn) from the
// normalized array, so the string form must normalize to a one-element
// array instead of silently reading as zero criteria (SRPG: M-core-systems
// and the crx verification tasks carried string criteria that spec export,
// task-context artifacts and tester aggregation all dropped to none).
export function normalizeAcceptanceCriteria(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

export function acceptanceCriteriaForTask(task) {
  return normalizeAcceptanceCriteria(task?.acceptanceCriteria ?? task?.input?.acceptanceCriteria);
}

export function acceptanceCriterionIds(task) {
  return acceptanceCriteriaForTask(task).map((_, index) => `AC${index + 1}`);
}

export function verificationForTask(task) {
  const rows = task?.verification ?? task?.input?.verification ?? [];
  return Array.isArray(rows) ? rows : [];
}

function verificationById(task) {
  return new Map(verificationForTask(task)
    .filter(row => row && typeof row === 'object' && typeof row.criterionId === 'string')
    .map(row => [row.criterionId, row]));
}

export function aggregateTesterSubmission(task, payload) {
  const requiredIds = acceptanceCriterionIds(task);
  const rawResult = payload?.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result
    : {};
  const rows = Array.isArray(rawResult.criteria) ? rawResult.criteria : [];
  const byId = new Map(rows
    .filter(row => row && typeof row === 'object' && typeof row.criterionId === 'string')
    .map(row => [row.criterionId, row]));
  const verification = verificationById(task);

  const normalized = requiredIds.map((criterionId, index) => {
    const row = byId.get(criterionId);
    const expected = verification.get(criterionId) ?? null;
    const submittedStatus = CRITERION_STATUSES.includes(row?.status) ? row.status : 'UNVERIFIED';
    const evidenceType = typeof row?.evidenceType === 'string' ? row.evidenceType : 'unknown';
    const runtimeMismatch = expected?.mode === 'runtime'
      && submittedStatus === 'SATISFIED'
      && evidenceType !== 'runtime';
    const status = runtimeMismatch ? 'UNVERIFIED' : submittedStatus;
    return {
      criterionId,
      requirement: acceptanceCriteriaForTask(task)[index],
      status,
      verification: expected ? structuredClone(expected) : null,
      evidenceType,
      evidence: Array.isArray(row?.evidence) ? structuredClone(row.evidence) : [],
      reason: runtimeMismatch
        ? 'Runtime verification required; non-runtime evidence cannot satisfy this criterion.'
        : (typeof row?.reason === 'string' && row.reason.trim()
          ? row.reason.trim()
          : (row ? 'No reason supplied.' : 'No tester result supplied for this required criterion.')),
    };
  });

  const allSatisfied = normalized.every(row => row.status === 'SATISFIED');
  return {
    ...payload,
    outcome: allSatisfied ? 'PASS' : 'NOT_PASS',
    result: {
      ...structuredClone(rawResult),
      criteria: normalized,
      aggregate: {
        required: normalized.length,
        satisfied: normalized.filter(row => row.status === 'SATISFIED').length,
        failed: normalized.filter(row => row.status === 'FAILED').length,
        unverified: normalized.filter(row => row.status === 'UNVERIFIED').length,
        blocked: normalized.filter(row => row.status === 'BLOCKED').length,
        computedOutcome: allSatisfied ? 'PASS' : 'NOT_PASS',
        submittedOutcome: payload?.outcome ?? null,
      },
    },
  };
}
