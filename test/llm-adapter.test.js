import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleLLM, llmFromEnv } from '../src/llm/openai-compatible.js';
import { evalPmDecomposition, evalReviewer, evalProjectDebugger } from '../src/llm/role-evals.js';

function response(content, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    async json() { return { choices: [{ message: { content } }] }; },
    async text() { return content; },
  };
}

test('OpenAI-compatible client sends normalized chat completion request', async () => {
  let captured;
  const llm = new OpenAICompatibleLLM({
    baseUrl: 'https://example.test/v1/', model: 'tiny-model', apiKey: 'secret',
    fetchImpl: async (url, init) => { captured = { url, init }; return response('{"ok":true}'); },
  });
  const result = await llm.complete({ messages: [{ role: 'user', content: 'hi' }], json: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, 'https://example.test/v1/chat/completions');
  assert.equal(captured.init.headers.authorization, 'Bearer secret');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'tiny-model');
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('client tolerates fenced JSON from weak models', async () => {
  const llm = new OpenAICompatibleLLM({ baseUrl: 'http://local/v1', model: 'tiny', fetchImpl: async () => response('```json\n{"answer":42}\n```') });
  assert.deepEqual(await llm.complete({ messages: [], json: true }), { answer: 42 });
});

test('llmFromEnv skips when live endpoint is not configured', () => {
  assert.equal(llmFromEnv({}), null);
});

test('PM evaluator validates task decomposition properties rather than wording', async () => {
  const llm = { complete: async () => ({ tasks: [
    { id: 'T1', title: 'Implement parser', dependsOn: [], acceptanceCriteria: ['parses valid input'] },
    { id: 'T2', title: 'Add tests', dependsOn: ['T1'], acceptanceCriteria: ['invalid input is rejected'] },
  ] }) };
  const result = await evalPmDecomposition(llm, 'Add a parser with tests');
  assert.equal(result.tasks.length, 2);
});

test('Reviewer evaluator accepts semantic NOT_PASS independent of exact explanation', async () => {
  const llm = { complete: async () => ({ outcome: 'NOT_PASS', findings: [{ severity: 'high', reason: 'violates required behavior' }] }) };
  const result = await evalReviewer(llm, { specification: 'Never delete existing records.', evidence: 'Patch deletes all records; unit tests still pass.' });
  assert.equal(result.outcome, 'NOT_PASS');
});

test('Project Debugger evaluator constrains diagnosis to Ariad project causes', async () => {
  const llm = { complete: async () => ({ kind: 'TASK_TOO_LARGE', reason: 'multiple independent subsystems', guidance: 'split the task' }) };
  const result = await evalProjectDebugger(llm, 'Three implementation cycles failed for unrelated subsystems.');
  assert.equal(result.kind, 'TASK_TOO_LARGE');
});

test('Project Debugger rejects invalid free-form diagnosis', async () => {
  const llm = { complete: async () => ({ kind: 'RESTART_GPU', reason: 'maybe infra', guidance: '' }) };
  await assert.rejects(() => evalProjectDebugger(llm, 'Repeated project failures'), /invalid kind/);
});
