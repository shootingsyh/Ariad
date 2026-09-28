export const ARIAD_MODEL_ROLES = Object.freeze([
  'artist',
  'developer',
  'tester',
  'reviewer',
  'project_debugger',
  'tech_lead',
  'tech_lead_critic',
  'pm',
]);

export function normalizeRoleModels(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('roleModels must be an object');
  }
  const allowed = new Set(ARIAD_MODEL_ROLES);
  const result = {};
  for (const [role, raw] of Object.entries(value)) {
    if (!allowed.has(role)) throw new Error(`unknown Ariad model role: ${role}`);
    const model = String(raw ?? '').trim();
    if (!model || !model.includes('/')) {
      throw new Error(`role model for ${role} must be an explicit provider/model ref`);
    }
    result[role] = model;
  }
  return result;
}

export function missingRoleModels(roleModels = {}) {
  return ARIAD_MODEL_ROLES.filter(role => !String(roleModels?.[role] ?? '').trim());
}

export function requireCompleteRoleModels(roleModels = {}) {
  const normalized = normalizeRoleModels(roleModels);
  const missing = missingRoleModels(normalized);
  if (missing.length) throw new Error(`Ariad role models are required before start; missing: ${missing.join(', ')}`);
  return normalized;
}
