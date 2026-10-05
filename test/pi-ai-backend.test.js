import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

import {
  ARIAD_ROLE_RESULT_TOOL,
  PiAiBackend,
  resolveHostedModelTarget,
} from '../src/runtime/pi-ai-backend.js';

test('hosted model refs route to Pi providers without fallback', () => {
  assert.deepEqual(resolveHostedModelTarget('openai/gpt-5.6-terra'), {
    backend: 'pi-ai',
    provider: 'openai-codex',
    model: 'gpt-5.6-terra',
  });
  assert.deepEqual(resolveHostedModelTarget('meta/muse-spark-1.1'), {
    backend: 'pi-ai',
    provider: 'meta',
    model: 'muse-spark-1.1',
  });
  assert.equal(resolveHostedModelTarget('llamacpp/qwen3.8-27b'), null);
});

test('Pi builtins expose Codex and Meta hosted providers', () => {
  const models = builtinModels();
  const providers = new Set(models.getProviders().map(provider => provider.id));
  assert.equal(providers.has('openai-codex'), true, 'Pi must expose OpenAI Codex subscription provider');
  assert.equal(providers.has('meta'), true, 'Pi must expose Meta Model API provider');
});

test('PiAiBackend runs Ariad tool loop and terminates through structured role result', async () => {
  const faux = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'gpt-5.6-terra', reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('workspace_probe', {}),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxToolCall(ARIAD_ROLE_RESULT_TOOL, {
        outcome: 'PLANNED',
        summary: 'frontier planned',
        keyPoints: ['pi-ai-tool-loop'],
        artifacts: [],
        result: { frontier: 'root' },
      }),
    ], { stopReason: 'toolUse' }),
  ]);

  const backend = new PiAiBackend({ models });
  const calls = [];
  const result = await backend.execute({
    modelRef: 'openai/gpt-5.6-terra',
    prompt: 'Inspect the workspace and submit the plan.',
    tools: [{
      name: 'workspace_probe',
      description: 'Inspect workspace root.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }],
    executeTool: async (name, args) => {
      calls.push({ name, args });
      return 'README.md';
    },
    sessionId: 'tl:demo',
  });

  assert.deepEqual(calls, [{ name: 'workspace_probe', args: {} }]);
  assert.equal(result.outcome, 'PLANNED');
  assert.equal(result.summary, 'frontier planned');
  assert.deepEqual(result.result, { frontier: 'root' });
  assert.equal(result.provider, 'openai-codex');
  assert.equal(result.model, 'gpt-5.6-terra');
  assert.equal(result.turns, 2);
  assert.equal(
    result.transcript.some(message => message.role === 'toolResult' && message.toolName === 'workspace_probe'),
    true,
  );
});

test('PiAiBackend fails closed when configured hosted model is absent', () => {
  const faux = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'different-model', reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = new PiAiBackend({ models });

  assert.throws(
    () => backend.requireModel('openai/gpt-5.6-terra'),
    /MODEL_PROVIDER_UNAVAILABLE: provider=openai-codex model=gpt-5\.6-terra/,
  );
});

test('PiAiBackend never treats local model refs as hosted fallback', () => {
  const models = createModels();
  const backend = new PiAiBackend({ models });
  assert.throws(
    () => backend.requireModel('llamacpp/qwen3.8-27b'),
    /MODEL_PROVIDER_UNAVAILABLE: no Pi hosted-provider mapping/,
  );
});
