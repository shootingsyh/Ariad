import { PromptRenderer } from './prompt-renderer.js';

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function validate(role, result) {
  requireObject(result, `${role} result`);
  if (!['COMPLETED', 'FAILED'].includes(result.executionStatus)) {
    throw new Error(`${role} executionStatus must be COMPLETED or FAILED`);
  }
  if (result.executionStatus === 'FAILED') return result;

  if (role === 'tester' || role === 'reviewer') {
    if (!['PASS', 'NOT_PASS'].includes(result.outcome)) throw new Error(`${role} outcome must be PASS or NOT_PASS`);
  } else if (role === 'project_debugger') {
    const allowed = ['WRONG_IMPLEMENTATION_APPROACH', 'TASK_TOO_LARGE', 'TASK_CONTRADICTORY', 'UNKNOWN_PROJECT_CAUSE'];
    if (!allowed.includes(result.outcome)) throw new Error('project_debugger returned an invalid outcome');
  } else if (role === 'pm') {
    if (!['REPLANNED', 'NEEDS_HUMAN'].includes(result.outcome)) throw new Error('pm outcome must be REPLANNED or NEEDS_HUMAN');
  }
  return result;
}

export class LLMWorkflowRoleExecutor {
  constructor(llm, { renderer = new PromptRenderer() } = {}) {
    if (!llm || typeof llm.complete !== 'function') throw new Error('llm.complete is required');
    if (!renderer || typeof renderer.render !== 'function') throw new Error('renderer.render is required');
    this.llm = llm;
    this.renderer = renderer;
    this.calls = [];
  }

  async run(role, context) {
    const request = this.renderer.render(role, context);
    this.calls.push({ role, context: structuredClone(context) });
    const result = await this.llm.complete(request);
    return validate(role, result);
  }
}
