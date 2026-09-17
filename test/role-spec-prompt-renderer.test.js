import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_SPECS, getRoleSpec } from '../src/llm/role-specs.js';
import { PromptRenderer } from '../src/llm/prompt-renderer.js';
import { LLMWorkflowRoleExecutor } from '../src/llm/workflow-role-executor.js';

const ROLES = ['developer', 'tester', 'reviewer', 'project_debugger', 'pm', 'system_debugger', 'artist'];

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
  const context = {
    taskId: 'T1',
    acceptanceCriteria: ['returns 200'],
    strategyGuidance: 'avoid global state',
    devCycle: 2,
    strategyEpoch: 1,
  };
  const request = renderer.render('reviewer', context);

  assert.equal(request.json, true);
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /Ariad's reviewer role/);
  assert.match(request.messages[0].content, /Passing tests do not override a specification violation/);
  assert.match(request.messages[0].content, /executionStatus=FAILED/);
  assert.match(request.messages[0].content, /PASS\|NOT_PASS/);
  assert.deepEqual(JSON.parse(request.messages[1].content), context);
});

test('PM prompt defines Task Graph planning rather than workflow-stage planning', () => {
  const request = new PromptRenderer().render('pm', { requirement: 'build feature' });
  const system = request.messages[0].content;
  assert.match(system, /task graph/i);
  assert.match(system, /Developer\/Tester\/Reviewer are workflow stages, not PM tasks/);
  assert.match(system, /acceptance criteria/i);
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
  const llm = {
    async complete(request) {
      assert.equal(request.messages[0].content, 'custom');
      return { executionStatus: 'COMPLETED', outcome: 'PASS' };
    },
  };
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
