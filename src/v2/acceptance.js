export const CRITERION_STATUSES = Object.freeze([
  'SATISFIED',
  'FAILED',
  'UNVERIFIED',
  'BLOCKED',
]);

export function acceptanceCriteriaForTask(task) {
  const criteria = task?.acceptanceCriteria ?? task?.input?.acceptanceCriteria ?? [];
  return Array.isArray(criteria) ? criteria : [];
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
