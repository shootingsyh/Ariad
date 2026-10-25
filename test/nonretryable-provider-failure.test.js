import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonretryableProviderFailure } from '../src/v2/nonretryable-provider-failure.js';

test('terminal model configuration failures do not qualify for retry', () => {
  for (const failure of [
    'MODEL_PROVIDER_UNAVAILABLE: provider=openai-codex model=gpt-5.6',
    "PI_PROVIDER_ERROR: Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    'PI_PROVIDER_ERROR: 404: model not found',
  ]) assert.equal(isNonretryableProviderFailure(failure), true);
  for (const failure of ['PI_PROVIDER_ERROR: 429 rate limit', 'network timeout', '503 service unavailable']) {
    assert.equal(isNonretryableProviderFailure(failure), false);
  }
});
