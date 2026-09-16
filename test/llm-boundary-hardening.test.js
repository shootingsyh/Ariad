import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedLLM, ScriptedLLMError } from '../src/llm/scripted.js';
import {
  evalPmDecomposition,
  evalReviewer,
  evalProjectDebugger,
} from '../src/llm/role-evals.js';

function anyJsonRequest(output) {
  return { match: (request) => request.json === true, output };
}

test('PM rejects malformed model output with no acceptance criteria', async () => {
  const llm = new ScriptedLLM([
    anyJsonRequest({
      tasks: [{ id: 'T1', title: 'Implement cache', dependsOn: [], acceptanceCriteria: [] }],
    }),
  ]);

  await assert.rejects(
    () => evalPmDecomposition(llm, 'Add a cache.'),
    /acceptanceCriteria must be non-empty/,
  );
  llm.assertExhausted();
});

test('PM rejects malformed task dependency shape', async () => {
  const llm = new ScriptedLLM([
    anyJsonRequest({
      tasks: [{ id: 'T1', title: 'Implement cache', dependsOn: 'T0', acceptanceCriteria: ['works'] }],
    }),
  ]);

  await assert.rejects(
    () => evalPmDecomposition(llm, 'Add a cache.'),
    /dependsOn must be an array/,
  );
  llm.assertExhausted();
});

test('Reviewer rejects model output outside the business outcome enum', async () => {
  const llm = new ScriptedLLM([
    anyJsonRequest({ outcome: 'MAYBE', findings: [] }),
  ]);

  await assert.rejects(
    () => evalReviewer(llm, { specification: 'Must be safe.', evidence: 'Patch is ambiguous.' }),
    /outcome must be PASS or NOT_PASS/,
  );
  llm.assertExhausted();
});

test('Reviewer rejects malformed findings instead of treating them as success', async () => {
  const llm = new ScriptedLLM([
    anyJsonRequest({ outcome: 'PASS', findings: 'none' }),
  ]);

  await assert.rejects(
    () => evalReviewer(llm, { specification: 'Must be safe.', evidence: 'Tests pass.' }),
    /findings must be an array/,
  );
  llm.assertExhausted();
});

test('Project Debugger rejects infrastructure actions as project diagnoses', async () => {
  const llm = new ScriptedLLM([
    anyJsonRequest({ kind: 'RESTART_MODEL', reason: 'runtime seems stuck', guidance: 'restart it' }),
  ]);

  await assert.rejects(
    () => evalProjectDebugger(llm, 'Three semantic implementation attempts failed.'),
    /invalid kind/,
  );
  llm.assertExhausted();
});

test('Project Debugger requires a non-empty reason', async () => {
  const llm = new ScriptedLLM([
    anyJsonRequest({ kind: 'TASK_TOO_LARGE', reason: '', guidance: 'split it' }),
  ]);

  await assert.rejects(
    () => evalProjectDebugger(llm, 'Repeated non-convergence.'),
    /reason must be a non-empty string/,
  );
  llm.assertExhausted();
});

test('provider failures propagate without being converted into business NOT_PASS', async () => {
  const llm = new ScriptedLLM([
    { match: () => true, error: new Error('synthetic provider timeout') },
  ]);

  await assert.rejects(
    () => evalReviewer(llm, { specification: 'Must work.', evidence: 'candidate patch' }),
    /synthetic provider timeout/,
  );
  llm.assertExhausted();
});

test('invalid role input is rejected before any LLM call is consumed', async () => {
  const llm = new ScriptedLLM([
    anyJsonRequest({ tasks: [] }),
  ]);

  await assert.rejects(() => evalPmDecomposition(llm, '   '), /requirement must be a non-empty string/);
  assert.equal(llm.calls.length, 0);
  assert.throws(
    () => llm.assertExhausted(),
    (error) => error instanceof ScriptedLLMError && /1 scripted LLM expectation/.test(error.message),
  );
});
