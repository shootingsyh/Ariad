import { Type } from 'typebox';

export type RoleResultBinding = {
  sessionKey: string;
  projectId: string;
  taskId: string;
  role: string;
  attemptId: string;
};

export type RoleResultPayload = {
  attemptId?: string;
  outcome: string;
  summary: string;
  keyPoints?: string[];
  artifacts?: string[];
  result?: unknown;
};

export class RoleResultSessionRegistry {
  private readonly bindings = new Map<string, RoleResultBinding>();
  private readonly attempts = new Map<string, RoleResultBinding>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2048) {
    this.maxEntries = maxEntries;
  }

  bind(binding: RoleResultBinding) {
    this.bindings.delete(binding.sessionKey);
    this.bindings.set(binding.sessionKey, binding);
    this.attempts.delete(binding.attemptId);
    this.attempts.set(binding.attemptId, binding);
    while (this.bindings.size > this.maxEntries) {
      const oldest = this.bindings.keys().next().value;
      if (!oldest) break;
      const removed = this.bindings.get(oldest);
      this.bindings.delete(oldest);
      if (removed && this.attempts.get(removed.attemptId)?.sessionKey === oldest) {
        this.attempts.delete(removed.attemptId);
      }
    }
  }

  get(sessionKey?: string | null) {
    if (!sessionKey) return null;
    return this.bindings.get(sessionKey) ?? null;
  }

  getAttempt(attemptId?: string | null) {
    if (!attemptId) return null;
    return this.attempts.get(attemptId) ?? null;
  }
}

export const ROLE_RESULT_TOOL_NAMES: Record<string, string> = {
  artist: 'ariad_artist_result',
  developer: 'ariad_developer_result',
  tester: 'ariad_tester_result',
  reviewer: 'ariad_reviewer_result',
  project_debugger: 'ariad_project_debugger_result',
  tech_lead: 'ariad_tech_lead_result',
  tech_lead_critic: 'ariad_tech_lead_critic_result',
  pm: 'ariad_pm_result',
};

const commonFields = {
  attemptId: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  keyPoints: Type.Optional(Type.Array(Type.String())),
  artifacts: Type.Optional(Type.Array(Type.String())),
};

const schemas: Record<string, any> = {
  artist: Type.Object({
    outcome: Type.Union([Type.Literal('PASS'), Type.Literal('NOT_PASS'), Type.Literal('NEEDS_CAPABILITY')]),
    ...commonFields,
    result: Type.Optional(Type.Any()),
  }, { additionalProperties: false }),
  developer: Type.Object({
    outcome: Type.Union([Type.Literal('PASS'), Type.Literal('NOT_PASS')]),
    ...commonFields,
    result: Type.Optional(Type.Any()),
  }, { additionalProperties: false }),
  tester: Type.Object({
    outcome: Type.Union([Type.Literal('PASS'), Type.Literal('NOT_PASS')]),
    ...commonFields,
    result: Type.Optional(Type.Any()),
  }, { additionalProperties: false }),
  reviewer: Type.Object({
    outcome: Type.Union([Type.Literal('PASS'), Type.Literal('NOT_PASS')]),
    ...commonFields,
    result: Type.Optional(Type.Any()),
  }, { additionalProperties: false }),
  project_debugger: Type.Object({
    outcome: Type.Union([
      Type.Literal('WRONG_IMPLEMENTATION_APPROACH'),
      Type.Literal('TASK_TOO_LARGE'),
      Type.Literal('ASSET_ISSUE'),
      Type.Literal('NEEDS_HUMAN'),
    ]),
    ...commonFields,
    result: Type.Optional(Type.Any()),
  }, { additionalProperties: false }),
  tech_lead: Type.Object({
    outcome: Type.Union([Type.Literal('PLANNED'), Type.Literal('REPLANNED')]),
    ...commonFields,
    result: Type.Optional(Type.Any()),
  }, { additionalProperties: false }),
  tech_lead_critic: Type.Object({
    outcome: Type.Union([
      Type.Literal('CLEAN'),
      Type.Literal('MINOR_ONLY'),
      Type.Literal('ISSUES'),
    ]),
    ...commonFields,
    result: Type.Object({
      issues: Type.Array(Type.Object({
        severity: Type.Union([
          Type.Literal('error'),
          Type.Literal('major'),
          Type.Literal('minor'),
        ]),
        message: Type.String({ minLength: 1 }),
      }, { additionalProperties: false })),
      summary: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  pm: Type.Object({
    outcome: Type.Union([
      Type.Literal('PLAN_ACCEPTED'),
      Type.Literal('PLAN_REVISION_REQUIRED'),
      Type.Literal('NEEDS_HUMAN'),
    ]),
    ...commonFields,
    result: Type.Object({
      reason: Type.String({ minLength: 1 }),
      startDelivery: Type.Boolean({ description: 'Explicit PM decision to open the durable delivery scheduler gate after accepting this plan.' }),
      guidance: Type.Optional(Type.String()),
      questions: Type.Array(Type.String()),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
};

export function roleResultToolName(role: string) {
  return ROLE_RESULT_TOOL_NAMES[role] ?? null;
}

export function roleResultToolMetadata() {
  return Object.entries(ROLE_RESULT_TOOL_NAMES).map(([role, name]) => ({
    name,
    label: `Ariad ${role} result`,
    description: `Submit the authoritative structured Ariad result for the current ${role} execution. This MUST be the final action of the role. If arguments are rejected, correct them and retry; once accepted, the execution is terminated.`,
    parameters: schemas[role],
    optional: true,
  }));
}

export function registerRoleResultTools({
  api,
  submit,
  terminate,
}: {
  api: any;
  submit: (attemptId: string, role: string, payload: Omit<RoleResultPayload, 'attemptId'>) => Promise<any> | any;
  terminate?: (attemptId: string) => void;
}) {
  for (const [role, name] of Object.entries(ROLE_RESULT_TOOL_NAMES)) {
    api.registerTool({
      name,
      label: `Ariad ${role} result`,
      description: `Submit the authoritative structured Ariad result for the current ${role} execution. This MUST be the final action of the role. If arguments are rejected, correct them and retry; once accepted, the execution is terminated.`,
      parameters: schemas[role],
      async execute(_toolCallId: string, params: RoleResultPayload) {
        const attemptId = typeof params.attemptId === 'string' ? params.attemptId.trim() : '';
        if (!attemptId) throw new Error('attemptId is required.');
        const { attemptId: _attemptId, ...payload } = params;
        const result = await submit(attemptId, role, payload);
        if (result?.accepted) terminate?.(attemptId);
        return {
          content: [{
            type: 'text',
            text: result.alreadySubmitted
              ? 'Ariad result is already sealed; this execution is terminating.'
              : 'Ariad result accepted and sealed; this execution is terminating.',
          }],
          details: result,
        };
      },
    }, { name, optional: true });
  }
}
