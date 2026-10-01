export function legacyHumanGateTarget(stage) {
  if (['artist', 'developer', 'tester', 'reviewer'].includes(stage)) return 'project_debugger';
  if (['pm', 'plan_validator', 'tech_lead_critic'].includes(stage)) return 'tech_lead';
  return null;
}
