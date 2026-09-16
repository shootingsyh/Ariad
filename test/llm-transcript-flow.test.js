import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedLLM, ScriptedLLMError } from '../src/llm/scripted.js';
import {
  evalPmDecomposition,
  evalReviewer,
  evalProjectDebugger,
} from '../src/llm/role-evals.js';

function roleMatcher(roleText, userText) {
  return (request) =>
    request.json === true &&
    request.messages?.[0]?.role === 'system' &&
    request.messages[0].content.includes(roleText) &&
    request.messages?.[1]?.role === 'user' &&
    request.messages[1].content.includes(userText);
}

test('one scripted transcript can model PM -> Reviewer -> Project Debugger in exact order', async () => {
  const llm = new ScriptedLLM([
    {
      match: roleMatcher('PM role in Ariad', 'Add an expiring cache'),
      output: {
        tasks: [
          { id: 'T1', title: 'Implement cache', dependsOn: [], acceptanceCriteria: ['values expire after TTL'] },
          { id: 'T2', title: 'Add expiry tests', dependsOn: ['T1'], acceptanceCriteria: ['expired values are absent'] },
        ],
      },
    },
    {
      match: roleMatcher("Ariad's Reviewer", 'TTL must be enforced'),
      output: {
        outcome: 'NOT_PASS',
        findings: [{ severity: 'high', reason: 'candidate never evicts expired values' }],
      },
    },
    {
      match: roleMatcher("Ariad's Project Debugger", 'three reviewer rejections'),
      output: {
        kind: 'WRONG_IMPLEMENTATION_APPROACH',
        reason: 'the implementation checks TTL only on insertion',
        guidance: 'validate expiry on read or schedule eviction',
      },
    },
  ]);

  const plan = await evalPmDecomposition(llm, 'Add an expiring cache with tests.');
  assert.equal(plan.tasks.length, 2);

  const review = await evalReviewer(llm, {
    specification: 'TTL must be enforced when cached values are read.',
    evidence: 'Tests pass for insertion, but expired values remain readable.',
  });
  assert.equal(review.outcome, 'NOT_PASS');

  const diagnosis = await evalProjectDebugger(
    llm,
    'There were three reviewer rejections because expired values remained readable after each developer cycle.',
  );
  assert.equal(diagnosis.kind, 'WRONG_IMPLEMENTATION_APPROACH');

  assert.equal(llm.calls.length, 3);
  llm.assertExhausted();
});

test('shared transcript fails immediately if Ariad invokes roles out of order', async () => {
  const llm = new ScriptedLLM([
    {
      match: roleMatcher('PM role in Ariad', 'feature A'),
      output: { tasks: [{ id: 'T1', title: 'Task', dependsOn: [], acceptanceCriteria: ['done'] }] },
    },
    {
      match: roleMatcher("Ariad's Reviewer", 'feature A'),
      output: { outcome: 'PASS', findings: [] },
    },
  ]);

  await assert.rejects(
    () => evalReviewer(llm, { specification: 'feature A', evidence: 'candidate' }),
    (error) => error instanceof ScriptedLLMError && /request mismatch/.test(error.message),
  );
});

test('partial multi-role execution leaves an explicit unmet transcript expectation', async () => {
  const llm = new ScriptedLLM([
    {
      match: roleMatcher('PM role in Ariad', 'feature B'),
      output: { tasks: [{ id: 'T1', title: 'Task', dependsOn: [], acceptanceCriteria: ['done'] }] },
    },
    {
      match: roleMatcher("Ariad's Reviewer", 'feature B'),
      output: { outcome: 'PASS', findings: [] },
    },
  ]);

  await evalPmDecomposition(llm, 'feature B');
  assert.throws(
    () => llm.assertExhausted(),
    (error) => error instanceof ScriptedLLMError && /1 scripted LLM expectation/.test(error.message),
  );
});
