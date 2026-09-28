const HUMAN_REQUIREMENT_PATTERNS = [
  /\bexternal human(s| players?| testers?)?\b/i,
  /\bhuman playtest(ing|ers?)?\b/i,
  /\bmanual owner (test|testing|review|verification)\b/i,
  /\bowner (must|should|needs? to) (test|verify|review|run)\b/i,
  /\bmanual (human )?(test|testing|review|verification|data entry)\b/i,
  /\b(?:[2-9]|[1-9]\d+)\s+(human|real)\s+(players?|testers?|users?)\b/i,
];

const EXPLICIT_HUMAN_REQUEST_PATTERNS = [
  /\bhuman playtest/i,
  /\buser study/i,
  /\bexternal testers?/i,
  /\breal users?/i,
  /\bmanual owner test/i,
];

function textOf(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return ''; }
}

export function validatePlanAutonomy(plan, planningRequests = []) {
  const requestText = planningRequests.map(item => textOf(item?.request ?? item)).join('\n');
  const explicitlyRequested = EXPLICIT_HUMAN_REQUEST_PATTERNS.some(re => re.test(requestText));
  if (explicitlyRequested) return { ok: true, explicitlyRequestedHumanWork: true };

  const violations = [];
  for (const task of plan?.tasks ?? []) {
    const text = [task?.title, task?.intent, ...(task?.acceptanceCriteria ?? []), task?.testStrategy]
      .filter(Boolean).join('\n');
    const match = HUMAN_REQUIREMENT_PATTERNS.find(re => re.test(text));
    if (match) violations.push({ taskId: task.id, reason: 'required external/manual human work', text });
  }
  for (const milestone of plan?.milestones ?? []) {
    const text = [milestone?.title, milestone?.goal, ...(milestone?.acceptanceCriteria ?? []), milestone?.testStrategy]
      .filter(Boolean).join('\n');
    const match = HUMAN_REQUIREMENT_PATTERNS.find(re => re.test(text));
    if (match) violations.push({ milestoneId: milestone.id, reason: 'required external/manual human work', text });
  }
  if (violations.length) {
    const error = new Error(
      'INVALID_AUTONOMY_REQUIREMENT: required acceptance work depends on external/manual humans but the user did not explicitly request a human study. Replace it with autonomous execution/simulation/heuristic verification.'
    );
    error.code = 'INVALID_AUTONOMY_REQUIREMENT';
    error.violations = violations;
    throw error;
  }
  return { ok: true, explicitlyRequestedHumanWork: false };
}
