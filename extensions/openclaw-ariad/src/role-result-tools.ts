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
    description: `Submit the authoritative structured Ariad result for the current ${role} execution. Call this before ending the role. If arguments are rejected, correct them and retry.`,
    parameters: schemas[role],
  }));
}

export function registerRoleResultTools({
  api,
  registry,
  submit,
}: {
  api: any;
  registry: RoleResultSessionRegistry;
  submit: (binding: RoleResultBinding, payload: RoleResultPayload) => Promise<any> | any;
}) {
  for (const [role, name] of Object.entries(ROLE_RESULT_TOOL_NAMES)) {
    try {
      api.registerTool(
        (context: any) => {
          return {
            name,
            label: `Ariad ${role} result`,
            description: `Submit the authoritative structured Ariad result for the current ${role} execution. Call this before ending the role. If arguments are rejected, correct them and retry.`,
            parameters: schemas[role],
            async execute(_toolCallId: string, params: RoleResultPayload) {
              // toolsAlsoAllow controls model visibility. Resolve the durable
              // execution binding at call time so tool construction never races
              // subagent session registration.
              const attemptId = typeof params.attemptId === 'string' ? params.attemptId.trim() : '';
              const binding = registry.getAttempt(attemptId);
              if (!binding) throw new Error(`No active Ariad execution matches attemptId ${attemptId || '<missing>'}.`);
              if (binding.role !== role) {
                throw new Error(`Ariad attempt ${attemptId} belongs to role ${binding.role}, not ${role}.`);
              }
              const { attemptId: _attemptId, ...payload } = params;
              const result = await submit(binding, payload);
              return {
                content: [{
                  type: 'text',
                  text: result.alreadySubmitted
                    ? 'Ariad result was already submitted successfully and is sealed; keep the existing result.'
                    : 'Ariad result accepted and sealed. No further result submission is needed.',
                }],
                details: result,
              };
            },
          };
        },
        { name },
      );
    } catch (error) {
      throw new Error(`failed to register Ariad role result tool ${name} for ${role}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
