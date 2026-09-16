const jsonOnly = 'Return only one JSON object. Do not wrap it in markdown.';

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

export async function evalPmDecomposition(llm, requirement) {
  requireString(requirement, 'requirement');
  const result = await llm.complete({ json: true, messages: [
    { role: 'system', content: `You are the PM role in Ariad. Decompose engineering work, but do not implement it. ${jsonOnly} Schema: {"tasks":[{"id":"string","title":"string","dependsOn":["id"],"acceptanceCriteria":["string"]}]}` },
    { role: 'user', content: requirement },
  ]});
  if (!Array.isArray(result.tasks) || result.tasks.length < 1) throw new Error('PM result requires tasks');
  for (const task of result.tasks) {
    requireString(task.id, 'task.id');
    requireString(task.title, 'task.title');
    if (!Array.isArray(task.dependsOn)) throw new Error('task.dependsOn must be an array');
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length < 1) throw new Error('task.acceptanceCriteria must be non-empty');
  }
  return result;
}

export async function evalReviewer(llm, { specification, evidence }) {
  requireString(specification, 'specification');
  requireString(evidence, 'evidence');
  const result = await llm.complete({ json: true, messages: [
    { role: 'system', content: `You are Ariad's Reviewer. Judge semantic compliance with the specification using supplied evidence. Passing tests do not override a specification violation. ${jsonOnly} Schema: {"outcome":"PASS|NOT_PASS","findings":[{"severity":"string","reason":"string"}]}` },
    { role: 'user', content: `SPECIFICATION:\n${specification}\n\nEVIDENCE:\n${evidence}` },
  ]});
  if (!['PASS', 'NOT_PASS'].includes(result.outcome)) throw new Error('Reviewer outcome must be PASS or NOT_PASS');
  if (!Array.isArray(result.findings)) throw new Error('Reviewer findings must be an array');
  return result;
}

const DEBUGGER_KINDS = ['WRONG_IMPLEMENTATION_APPROACH', 'TASK_TOO_LARGE', 'TASK_CONTRADICTORY', 'UNKNOWN_PROJECT_CAUSE'];

export async function evalProjectDebugger(llm, failureHistory) {
  requireString(failureHistory, 'failureHistory');
  const result = await llm.complete({ json: true, messages: [
    { role: 'system', content: `You are Ariad's Project Debugger. Diagnose repeated business/project non-convergence. Do not edit files and do not recommend infrastructure recovery. ${jsonOnly} Schema: {"kind":"WRONG_IMPLEMENTATION_APPROACH|TASK_TOO_LARGE|TASK_CONTRADICTORY|UNKNOWN_PROJECT_CAUSE","reason":"string","guidance":"string"}` },
    { role: 'user', content: failureHistory },
  ]});
  if (!DEBUGGER_KINDS.includes(result.kind)) throw new Error('Project Debugger returned an invalid kind');
  requireString(result.reason, 'reason');
  return result;
}
