import { Type } from '@earendil-works/pi-ai';

export const ARIAD_ROLE_RESULT_TOOL = 'ariad_submit_result';

export function resolveHostedModelTarget(modelRef) {
  const value = String(modelRef ?? '').trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid Ariad model ref: ${modelRef}`);
  }
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (provider === 'openai') return { backend: 'pi-ai', provider: 'openai-codex', model };
  if (provider === 'meta') return { backend: 'pi-ai', provider: 'meta', model };
  return null;
}

export function ariadRoleResultTool() {
  return {
    name: ARIAD_ROLE_RESULT_TOOL,
    description: 'Submit the final structured Ariad role result. Call exactly once only when the assigned role work is complete.',
    parameters: Type.Object({
      outcome: Type.String(),
      summary: Type.String(),
      keyPoints: Type.Optional(Type.Array(Type.String())),
      artifacts: Type.Optional(Type.Array(Type.String())),
      result: Type.Optional(Type.Any()),
    }),
  };
}

function textToolResult(call, text, isError = false) {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: String(text ?? '') }],
    isError,
    timestamp: Date.now(),
  };
}

function normalizedRoleResult(value) {
  const result = value && typeof value === 'object' ? value : {};
  if (typeof result.outcome !== 'string' || !result.outcome.trim()) {
    throw new Error('ARIAD_ROLE_RESULT_INVALID: outcome is required');
  }
  if (typeof result.summary !== 'string') {
    throw new Error('ARIAD_ROLE_RESULT_INVALID: summary is required');
  }
  return {
    outcome: result.outcome,
    summary: result.summary,
    keyPoints: Array.isArray(result.keyPoints) ? result.keyPoints : [],
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    result: result.result ?? null,
  };
}

export class PiAiBackend {
  constructor({ models, maxTurns = 64 } = {}) {
    if (!models || typeof models.getModel !== 'function' || typeof models.complete !== 'function') {
      throw new Error('PiAiBackend requires a pi-ai Models collection');
    }
    this.models = models;
    this.maxTurns = maxTurns;
  }

  requireModel(modelRef) {
    const target = resolveHostedModelTarget(modelRef);
    if (!target) {
      throw new Error(`MODEL_PROVIDER_UNAVAILABLE: no Pi hosted-provider mapping for ${modelRef}`);
    }
    const model = this.models.getModel(target.provider, target.model);
    if (!model) {
      throw new Error(
        `MODEL_PROVIDER_UNAVAILABLE: provider=${target.provider} model=${target.model} configuredRef=${modelRef}`,
      );
    }
    return { target, model };
  }

  async execute({
    modelRef,
    prompt,
    systemPrompt = '',
    tools = [],
    executeTool,
    signal,
    sessionId = null,
    cacheRetention = 'short',
  }) {
    const { target, model } = this.requireModel(modelRef);
    const roleResultTool = ariadRoleResultTool();
    const declaredTools = [...tools.filter(tool => tool?.name !== ARIAD_ROLE_RESULT_TOOL), roleResultTool];
    const context = {
      systemPrompt,
      messages: [{
        role: 'user',
        content: String(prompt ?? ''),
        timestamp: Date.now(),
      }],
      tools: declaredTools,
    };

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      if (signal?.aborted) throw new Error('PI_AI_RUN_CANCELLED');
      const assistant = await this.models.complete(model, context, {
        signal,
        sessionId: sessionId ?? undefined,
        cacheRetention,
      });
      context.messages.push(assistant);

      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
        throw new Error(assistant.errorMessage || `PI_AI_${String(assistant.stopReason).toUpperCase()}`);
      }

      const calls = assistant.content.filter(block => block?.type === 'toolCall');
      if (calls.length === 0) {
        throw new Error(
          `ARIAD_ROLE_RESULT_MISSING: provider=${target.provider} model=${target.model} turn=${turn}`,
        );
      }

      for (const call of calls) {
        if (call.name === ARIAD_ROLE_RESULT_TOOL) {
          return {
            ...normalizedRoleResult(call.arguments),
            provider: target.provider,
            model: target.model,
            turns: turn,
            transcript: context.messages,
          };
        }

        if (typeof executeTool !== 'function') {
          throw new Error(`PI_AI_TOOL_EXECUTOR_MISSING: ${call.name}`);
        }

        try {
          const value = await executeTool(call.name, call.arguments, {
            call,
            turn,
            signal,
          });
          context.messages.push(textToolResult(
            call,
            typeof value === 'string' ? value : JSON.stringify(value),
            false,
          ));
        } catch (error) {
          context.messages.push(textToolResult(
            call,
            error instanceof Error ? error.message : String(error),
            true,
          ));
        }
      }
    }

    throw new Error(`PI_AI_MAX_TURNS_EXCEEDED: ${this.maxTurns}`);
  }
}
