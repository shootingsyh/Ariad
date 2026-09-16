import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedLLM, ScriptedLLMError } from '../src/llm/scripted.js';

test('scripted LLM consumes exact requests in order and returns fixed outputs', async () => {
  const firstRequest = {
    messages: [
      { role: 'system', content: 'You are PM.' },
      { role: 'user', content: 'Split feature A.' },
    ],
    json: true,
    temperature: 0,
    maxTokens: 800,
  };
  const secondRequest = {
    messages: [
      { role: 'system', content: 'You are Reviewer.' },
      { role: 'user', content: 'Review patch B.' },
    ],
    json: true,
    temperature: 0,
    maxTokens: 800,
  };

  const llm = new ScriptedLLM([
    { request: firstRequest, output: { tasks: [{ id: 'T1' }] } },
    { request: secondRequest, output: { verdict: 'NOT_PASS', findings: ['spec mismatch'] } },
  ]);

  assert.deepEqual(await llm.complete(firstRequest), { tasks: [{ id: 'T1' }] });
  assert.deepEqual(await llm.complete(secondRequest), { verdict: 'NOT_PASS', findings: ['spec mismatch'] });
  assert.deepEqual(llm.calls, [firstRequest, secondRequest]);
  llm.assertExhausted();
});

test('scripted LLM fails immediately when call order or request changes', async () => {
  const llm = new ScriptedLLM([
    {
      request: { messages: [{ role: 'user', content: 'first' }], json: false, temperature: 0, maxTokens: 800 },
      output: 'one',
    },
  ]);

  await assert.rejects(
    () => llm.complete({ messages: [{ role: 'user', content: 'second' }], json: false, temperature: 0, maxTokens: 800 }),
    (error) => error instanceof ScriptedLLMError && /request mismatch/.test(error.message),
  );
});

test('scripted LLM detects unexpected extra calls', async () => {
  const llm = new ScriptedLLM([]);
  await assert.rejects(
    () => llm.complete({ messages: [], json: false }),
    (error) => error instanceof ScriptedLLMError && /unexpected LLM call/.test(error.message),
  );
});

test('scripted LLM detects expected calls that never happened', () => {
  const llm = new ScriptedLLM([{ request: { messages: [] }, output: 'unused' }]);
  assert.throws(
    () => llm.assertExhausted(),
    (error) => error instanceof ScriptedLLMError && /1 scripted LLM expectation/.test(error.message),
  );
});

test('scripted LLM supports predicate matching for intentionally variable request fields', async () => {
  const llm = new ScriptedLLM([
    {
      match: (request) => request.json === true && request.messages.some((m) => m.content.includes('TASK_TOO_LARGE')),
      output: { kind: 'TASK_TOO_LARGE', reason: 'too broad' },
    },
  ]);

  const result = await llm.complete({
    messages: [{ role: 'user', content: 'Choose TASK_TOO_LARGE when appropriate; run=R-123' }],
    json: true,
  });
  assert.equal(result.kind, 'TASK_TOO_LARGE');
  llm.assertExhausted();
});

test('scripted LLM can inject deterministic failures', async () => {
  const llm = new ScriptedLLM([
    { match: () => true, error: new Error('synthetic provider timeout') },
  ]);
  await assert.rejects(() => llm.complete({ messages: [] }), /synthetic provider timeout/);
  llm.assertExhausted();
});
