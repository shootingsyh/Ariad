import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowEngine } from '../src/workflow.js';
import { ScriptedLLM } from '../src/llm/scripted.js';
import { LLMWorkflowRoleExecutor } from '../src/llm/workflow-role-executor.js';

function step(role, expectedContext, output) {
  return {
    match(request) {
      const system = request.messages?.[0]?.content ?? '';
      const user = request.messages?.[1]?.content ?? '';
      if (!system.includes(`Ariad's ${role} role`)) return false;
      try {
        assert.deepEqual(JSON.parse(user), expectedContext);
        return request.json === true;
      } catch {
        return false;
      }
    },
    output,
  };
}

const completed = (outcome, extra = {}) => ({ executionStatus: 'COMPLETED', ...(outcome ? { outcome } : {}), ...extra });
const failed = (reason = 'synthetic runtime failure') => ({ executionStatus: 'FAILED', reason });

test('reviewer NOT_PASS loops back to Developer and increments only the development cycle', async () => {
  const llm = new ScriptedLLM([
    step('developer', { taskId: 'F1', strategyEpoch: 1, devCycle: 1 }, completed(null, { summary: 'first implementation' })),
    step('tester', { taskId: 'F1', strategyEpoch: 1, devCycle: 1 }, completed('PASS')),
    step('reviewer', { taskId: 'F1', strategyEpoch: 1, devCycle: 1 }, completed('NOT_PASS', { findings: ['spec mismatch'] })),
    step('developer', { taskId: 'F1', strategyEpoch: 1, devCycle: 2 }, completed(null, { summary: 'fixed implementation' })),
    step('tester', { taskId: 'F1', strategyEpoch: 1, devCycle: 2 }, completed('PASS')),
    step('reviewer', { taskId: 'F1', strategyEpoch: 1, devCycle: 2 }, completed('PASS')),
  ]);
  const engine = new WorkflowEngine(new LLMWorkflowRoleExecutor(llm));
  const result = await engine.runFeature('F1');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.devCycle, 2);
  assert.equal(result.strategyEpoch, 1);
  assert.deepEqual(result.history.map((x) => x.role), ['developer', 'tester', 'reviewer', 'developer', 'tester', 'reviewer', 'source_control_step']);
  llm.assertExhausted();
});

test('three semantic failures escalate to Project Debugger then Tech Lead replan', async () => {
  const script = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    script.push(
      step('developer', { taskId: 'F2', strategyEpoch: 1, devCycle: cycle }, completed(null)),
      step('tester', { taskId: 'F2', strategyEpoch: 1, devCycle: cycle }, completed('NOT_PASS', { findings: [`cycle ${cycle}`] })),
    );
  }
  script.push(
    step('project_debugger', { taskId: 'F2', strategyEpoch: 1, devCycle: 3 }, completed('TASK_TOO_LARGE', { reason: 'too broad' })),
    step('tech_lead', { taskId: 'F2', strategyEpoch: 1, devCycle: 3, diagnosis: 'TASK_TOO_LARGE' }, completed('REPLANNED', { tasks: ['A', 'B'] })),
  );

  const llm = new ScriptedLLM(script);
  const engine = new WorkflowEngine(new LLMWorkflowRoleExecutor(llm));
  const result = await engine.runFeature('F2');
  assert.equal(result.status, 'WAITING_REPLAN');
  assert.equal(result.devCycle, 3);
  assert.equal(result.strategyEpoch, 1);
  assert.equal(result.history.filter((x) => x.role === 'developer').length, 3);
  assert.equal(result.history.filter((x) => x.role === 'project_debugger').length, 1);
  assert.equal(result.history.filter((x) => x.role === 'tech_lead').length, 1);
  llm.assertExhausted();
});

test('system failure retries the same role without incrementing devCycle', async () => {
  const llm = new ScriptedLLM([
    step('developer', { taskId: 'F3', strategyEpoch: 1, devCycle: 1 }, completed(null)),
    step('tester', { taskId: 'F3', strategyEpoch: 1, devCycle: 1 }, failed('provider timeout')),
    step('tester', { taskId: 'F3', strategyEpoch: 1, devCycle: 1 }, completed('PASS')),
    step('reviewer', { taskId: 'F3', strategyEpoch: 1, devCycle: 1 }, completed('PASS')),
  ]);
  const engine = new WorkflowEngine(new LLMWorkflowRoleExecutor(llm), { maxSystemRetries: 2 });
  const result = await engine.runFeature('F3');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.devCycle, 1);
  assert.equal(result.history.filter((x) => x.role === 'tester').length, 2);
  assert.equal(result.history.some((x) => x.role === 'project_debugger'), false);
  llm.assertExhausted();
});

test('wrong implementation approach starts a new strategy epoch and resets devCycle', async () => {
  const script = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    script.push(
      step('developer', { taskId: 'F4', strategyEpoch: 1, devCycle: cycle }, completed(null)),
      step('tester', { taskId: 'F4', strategyEpoch: 1, devCycle: cycle }, completed('PASS')),
      step('reviewer', { taskId: 'F4', strategyEpoch: 1, devCycle: cycle }, completed('NOT_PASS')),
    );
  }
  script.push(
    step('project_debugger', { taskId: 'F4', strategyEpoch: 1, devCycle: 3 }, completed('WRONG_IMPLEMENTATION_APPROACH', { guidance: 'change strategy' })),
    step('developer', { taskId: 'F4', strategyEpoch: 2, devCycle: 1 }, completed(null)),
    step('tester', { taskId: 'F4', strategyEpoch: 2, devCycle: 1 }, completed('PASS')),
    step('reviewer', { taskId: 'F4', strategyEpoch: 2, devCycle: 1 }, completed('PASS')),
  );
  const llm = new ScriptedLLM(script);
  const engine = new WorkflowEngine(new LLMWorkflowRoleExecutor(llm));
  const result = await engine.runFeature('F4');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.strategyEpoch, 2);
  assert.equal(result.devCycle, 1);
  llm.assertExhausted();
});
