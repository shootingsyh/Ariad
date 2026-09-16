import test from 'node:test';
import assert from 'node:assert/strict';
import { llmFromEnv } from '../src/llm/openai-compatible.js';
import { evalPmDecomposition, evalReviewer, evalProjectDebugger } from '../src/llm/role-evals.js';

const llm = llmFromEnv();
const live = llm ? test : test.skip;

live('live PM decomposes a small engineering requirement into actionable tasks', async () => {
  const result = await evalPmDecomposition(llm, `Build a tiny HTTP health endpoint. It must return JSON with status=ok, include unit tests, and document how to run the tests. Do not implement the code; plan the work.`);
  assert.ok(result.tasks.length >= 1);
  assert.ok(result.tasks.every(task => task.acceptanceCriteria.length >= 1));
  const ids = new Set(result.tasks.map(task => task.id));
  for (const task of result.tasks) for (const dep of task.dependsOn) assert.ok(ids.has(dep), `unknown dependency ${dep}`);
});

live('live Reviewer catches a spec violation even when tests pass', async () => {
  const result = await evalReviewer(llm, {
    specification: 'The cache must preserve existing entries when a new entry is added unless capacity is exceeded. Capacity is 10.',
    evidence: 'All unit tests pass. The patch implements set(key,value) by calling map.clear() before inserting the new key, so adding a second entry deletes the first even though capacity is 10.',
  });
  assert.equal(result.outcome, 'NOT_PASS');
  assert.ok(result.findings.length >= 1);
});

live('live Project Debugger classifies an obviously oversized task', async () => {
  const result = await evalProjectDebugger(llm, `A single feature task asks one developer cycle to: redesign the database schema, migrate production data, rewrite the frontend, replace authentication, add a mobile app, and deploy new infrastructure. Three cycles failed because each only completed one subsystem; no infrastructure errors occurred.`);
  assert.equal(result.kind, 'TASK_TOO_LARGE');
});
