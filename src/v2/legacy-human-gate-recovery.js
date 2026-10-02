export function legacyHumanGateTarget(stage, task = null) {
  if (stage === 'pm') return null;

  if (stage === 'project_debugger') {
    const latestDebuggerResult = [...(task?.history ?? [])].reverse().find(
      entry => entry?.type === 'ROLE_RESULT' && entry?.role === 'project_debugger'
    );
    if (latestDebuggerResult?.outcome === 'WRONG_IMPLEMENTATION_APPROACH') return 'developer';
    if (latestDebuggerResult?.outcome === 'ASSET_ISSUE') return 'artist';
    if (latestDebuggerResult?.outcome === 'TASK_TOO_LARGE') return 'tech_lead';
    return 'pm';
  }

  if (['artist', 'developer', 'tester', 'reviewer'].includes(stage)) return 'project_debugger';
  if (['tech_lead', 'plan_validator', 'tech_lead_critic'].includes(stage)) return 'pm';
  return 'pm';
}
