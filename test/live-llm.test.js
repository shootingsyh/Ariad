import test from 'node:test';
import assert from 'node:assert/strict';
import { llmFromEnv } from '../src/llm/openai-compatible.js';
import { evalPmDecomposition, evalReviewer, evalProjectDebugger } from '../src/llm/role-evals.js';
import { LLMWorkflowRoleExecutor } from '../src/llm/workflow-role-executor.js';

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

live('live workflow Reviewer obeys the actual Ariad RoleSpec', async () => {
  const executor = new LLMWorkflowRoleExecutor(llm);
  const result = await executor.run('reviewer', {
    taskId: 'live-reviewer-role-spec',
    specification: 'Adding a cache entry must preserve prior entries until capacity 10 is exceeded.',
    acceptanceCriteria: ['Adding the second entry leaves the first entry readable.'],
    evidence: 'Tests report green, but implementation calls map.clear() before every set(), so adding entry B removes entry A.',
  });
  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.outcome, 'NOT_PASS');
});

live('live workflow Project Debugger obeys the actual Ariad RoleSpec', async () => {
  const executor = new LLMWorkflowRoleExecutor(llm);
  const result = await executor.run('project_debugger', {
    taskId: 'live-debugger-role-spec',
    devCycle: 3,
    failureHistory: [
      'Cycle 1 completed database redesign only.',
      'Cycle 2 completed frontend rewrite only.',
      'Cycle 3 completed authentication replacement only.',
    ],
    task: 'In one task: redesign DB, migrate production data, rewrite frontend, replace auth, add mobile app, and deploy infrastructure.',
    infrastructureHealthy: true,
  });
  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.outcome, 'TASK_TOO_LARGE');
});

live('live workflow PM treats Developer Tester Reviewer as stages rather than planned tasks', async () => {
  const executor = new LLMWorkflowRoleExecutor(llm);
  const result = await executor.run('pm', {
    requirement: 'Build a tiny health endpoint returning {status:"ok"}, with tests and run documentation.',
    instruction: 'Create or revise a small task graph.',
  });
  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.outcome, 'REPLANNED');
  assert.ok(Array.isArray(result.result?.tasks));
  assert.ok(result.result.tasks.length >= 1);
  const titles = result.result.tasks.map(task => task.title.toLowerCase());
  assert.equal(titles.some(title => /developer|tester|reviewer/.test(title)), false);
});
