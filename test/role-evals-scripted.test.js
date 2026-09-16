import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedLLM } from '../src/llm/scripted.js';
import { evalPmDecomposition, evalReviewer, evalProjectDebugger } from '../src/llm/role-evals.js';

const jsonOnly = 'Return only one JSON object. Do not wrap it in markdown.';

test('PM role emits the expected prompt and accepts a deterministic scripted plan', async () => {
  const requirement = 'Add a cache with invalidation and tests.';
  const llm = new ScriptedLLM([{ request: {
    json: true,
    messages: [
      { role: 'system', content: `You are the PM role in Ariad. Decompose engineering work, but do not implement it. ${jsonOnly} Schema: {"tasks":[{"id":"string","title":"string","dependsOn":["id"],"acceptanceCriteria":["string"]}]}` },
      { role: 'user', content: requirement },
    ],
  }, output: {
    tasks: [
      { id: 'T1', title: 'Implement cache', dependsOn: [], acceptanceCriteria: ['cache stores values'] },
      { id: 'T2', title: 'Add invalidation tests', dependsOn: ['T1'], acceptanceCriteria: ['stale values are removed'] },
    ],
  } }]);

  const result = await evalPmDecomposition(llm, requirement);
  assert.equal(result.tasks.length, 2);
  llm.assertExhausted();
});

test('Reviewer role transcript preserves the semantic-review boundary', async () => {
  const specification = 'Responses must never expose internal stack traces.';
  const evidence = 'All unit tests pass, but the patch returns error.stack in the HTTP response.';
  const llm = new ScriptedLLM([{ request: {
    json: true,
    messages: [
      { role: 'system', content: `You are Ariad's Reviewer. Judge semantic compliance with the specification using supplied evidence. Passing tests do not override a specification violation. ${jsonOnly} Schema: {"outcome":"PASS|NOT_PASS","findings":[{"severity":"string","reason":"string"}]}` },
      { role: 'user', content: `SPECIFICATION:\n${specification}\n\nEVIDENCE:\n${evidence}` },
    ],
  }, output: {
    outcome: 'NOT_PASS',
    findings: [{ severity: 'high', reason: 'stack trace exposure violates the specification' }],
  } }]);

  const result = await evalReviewer(llm, { specification, evidence });
  assert.equal(result.outcome, 'NOT_PASS');
  llm.assertExhausted();
});

test('Project Debugger role transcript classifies repeated non-convergence deterministically', async () => {
  const history = 'Three development cycles each attempted the entire compiler rewrite as one task; each timed out before producing a reviewable artifact.';
  const llm = new ScriptedLLM([{ request: {
    json: true,
    messages: [
      { role: 'system', content: `You are Ariad's Project Debugger. Diagnose repeated business/project non-convergence. Do not edit files and do not recommend infrastructure recovery. ${jsonOnly} Schema: {"kind":"WRONG_IMPLEMENTATION_APPROACH|TASK_TOO_LARGE|TASK_CONTRADICTORY|UNKNOWN_PROJECT_CAUSE","reason":"string","guidance":"string"}` },
      { role: 'user', content: history },
    ],
  }, output: {
    kind: 'TASK_TOO_LARGE',
    reason: 'the task is too broad for one development cycle',
    guidance: 'split it into independently reviewable compiler stages',
  } }]);

  const result = await evalProjectDebugger(llm, history);
  assert.equal(result.kind, 'TASK_TOO_LARGE');
  llm.assertExhausted();
});
