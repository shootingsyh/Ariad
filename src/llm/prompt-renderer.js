import { getRoleSpec } from './role-specs.js';

const JSON_ONLY = 'Return only one JSON object. Do not wrap it in markdown.';
const EXECUTION_BOUNDARY = 'Execution failure is different from business outcome. If runtime/tooling itself fails, use executionStatus=FAILED. Otherwise use executionStatus=COMPLETED and the role-specific business outcome.';

export class PromptRenderer {
  render(role, context = {}) {
    const spec = getRoleSpec(role);
    const rules = spec.rules.map(rule => `- ${rule}`).join('\n');
    return {
      json: true,
      messages: [
        {
          role: 'system',
          content: [
            `You are Ariad's ${spec.id} role.`,
            spec.mission,
            `Rules:\n${rules}`,
            EXECUTION_BOUNDARY,
            JSON_ONLY,
            `Output schema: ${spec.output}`,
          ].join('\n\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(context),
        },
      ],
    };
  }
}
