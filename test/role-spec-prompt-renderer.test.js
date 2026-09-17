import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_SPECS, getRoleSpec } from '../src/llm/role-specs.js';
import { PromptRenderer } from '../src/llm/prompt-renderer.js';
import { LLMWorkflowRoleExecutor } from '../src/llm/workflow-role-executor.js';

const ROLES = ['developer', 'tester', 'reviewer', 'project_debugger', 'tech_lead', 'pm', 'system_debugger', 'artist'];

test('all Ariad roles have substrate-neutral specs with explicit mission rules and output schema', () => {
  assert.deepEqual(Object.keys(ROLE_SPECS), ROLES);
  for (const role of ROLES) {
    const spec = getRoleSpec(role);
    assert.equal(spec.id, role);
    assert.ok(spec.mission.length > 20);
    assert.ok(spec.rules.length >= 2);
    assert.match(spec.output, /executionStatus/);
    assert.doesNotMatch(JSON.stringify(spec), /qwen|codex|muse|llama\.cpp|vllm|openai api/i);
  }
});

test('PromptRenderer combines role semantics with work context without substrate details', () => {
  const renderer = new PromptRenderer();
  const context = { taskId: 'T1', acceptanceCriteria: ['returns 200'], strategyGuidance: 'avoid global state', devCycle: 2, strategyEpoch: 1 };
  const request = renderer.render('reviewer', context);
  assert.equal(request.json, true);
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /Ariad's reviewer role/);
  assert.match(request.messages[0].content, /Passing tests do not override a specification or contract violation/);
  assert.match(request.messages[0].content, /executionStatus=FAILED/);
  assert.match(request.messages[0].content, /PASS\|NOT_PASS/);
  assert.deepEqual(JSON.parse(request.messages[1].content), context);
});

test('Tech Lead prompt defines horizontal vertical architecture, contracts, and atomic Task Graph leaves', () => {
  const system = new PromptRenderer().render('tech_lead', { requirement: 'build feature' }).messages[0].content;
  assert.match(system, /horizontal shared infrastructure/i);
  assert.match(system, /vertical user-facing product features/i);
  assert.match(system, /explicit contracts/i);
  assert.match(system, /Recursively decompose/i);
  assert.match(system, /Developer\/Tester\/Reviewer are workflow stages, not Tech Lead tasks/);
  assert.match(system, /acceptance criteria/i);
});

test('PM prompt owns product intent and customer satisfaction review rather than technical decomposition', () => {
  const system = new PromptRenderer().render('pm', { productPhase: 'PLAN_REVIEW' }).messages[0].content;
  assert.match(system, /user intent and product scope/i);
  assert.match(system, /complete user-visible outcome/i);
  assert.match(system, /every task in the graph/i);
  assert.match(system, /PLAN_REVISION_REQUIRED/);
  assert.doesNotMatch(system, /Developer\/Tester\/Reviewer are workflow stages, not PM tasks/);
});

test('Reviewer prompt explicitly denies source-control and mutation authority', () => {
  const system = new PromptRenderer().render('reviewer', {}).messages[0].content;
  assert.match(system, /Do not modify code, commit, merge, or push/);
});

test('Project Debugger prompt keeps infrastructure recovery outside project diagnosis', () => {
  const system = new PromptRenderer().render('project_debugger', {}).messages[0].content;
  assert.match(system, /infrastructure recovery belongs to Reliability/i);
  assert.match(system, /TASK_TOO_LARGE/);
  assert.match(system, /WRONG_IMPLEMENTATION_APPROACH/);
});

test('workflow role executor delegates prompt construction to injected renderer', async () => {
  const calls = [];
  const renderer = {
    render(role, context) {
      calls.push({ role, context });
      return { json: true, messages: [{ role: 'system', content: 'custom' }, { role: 'user', content: '{}' }] };
    },
  };
  const llm = { async complete(request) { assert.equal(request.messages[0].content, 'custom'); return { executionStatus: 'COMPLETED', outcome: 'PASS' }; } };
  const executor = new LLMWorkflowRoleExecutor(llm, { renderer });
  const result = await executor.run('reviewer', { taskId: 'T2' });
  assert.equal(result.outcome, 'PASS');
  assert.deepEqual(calls, [{ role: 'reviewer', context: { taskId: 'T2' } }]);
});

test('unknown roles are rejected before an LLM call', async () => {
  let called = false;
  const executor = new LLMWorkflowRoleExecutor({ async complete() { called = true; return {}; } });
  await assert.rejects(() => executor.run('wizard', {}), /unknown Ariad role/);
  assert.equal(called, false);
});
