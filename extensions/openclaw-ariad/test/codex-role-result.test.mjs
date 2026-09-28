import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_ROLE_RESULT_TOOL_NAME,
  registerCodexRoleResultTool,
} from '../dist/role-result-tools.js';
import { OpenClawRuntimeAdapter } from '../dist/openclaw-runtime-adapter.js';

function captureRegisteredTool(options) {
  let tool = null;
  let registration = null;
  registerCodexRoleResultTool({
    api: {
      registerTool(value, metadata) {
        tool = value;
        registration = metadata;
      },
    },
    ...options,
  });
  assert.ok(tool);
  return { tool, registration };
}

test('ariad_codex_role_result accepts only active Codex attempts and commits with the bound role', async () => {
  const submissions = [];
  const terminated = [];
  const { tool, registration } = captureRegisteredTool({
    resolveAttempt: (attemptId) => attemptId === 'attempt-1'
      ? {
          attemptId,
          role: 'tech_lead',
          harness: 'codex',
          provider: 'openai',
          model: 'gpt-5.6-terra',
        }
      : null,
    submit: async (attemptId, role, payload) => {
      submissions.push({ attemptId, role, payload });
      return { accepted: true, sealed: true };
    },
    terminate: (attemptId) => terminated.push(attemptId),
  });

  assert.equal(tool.name, CODEX_ROLE_RESULT_TOOL_NAME);
  assert.equal(registration.name, CODEX_ROLE_RESULT_TOOL_NAME);

  const result = await tool.execute('call-1', {
    attemptId: 'attempt-1',
    outcome: 'PLANNED',
    summary: 'Plan is ready.',
    keyPoints: ['validated'],
    artifacts: ['plan.json'],
    result: { nodeCount: 12 },
  });

  assert.deepEqual(submissions, [{
    attemptId: 'attempt-1',
    role: 'tech_lead',
    payload: {
      outcome: 'PLANNED',
      summary: 'Plan is ready.',
      keyPoints: ['validated'],
      artifacts: ['plan.json'],
      result: { nodeCount: 12 },
    },
  }]);
  assert.deepEqual(terminated, ['attempt-1']);
  assert.equal(result.details.accepted, true);
});

test('ariad_codex_role_result rejects non-Codex attempts', async () => {
  let submitted = false;
  const { tool } = captureRegisteredTool({
    resolveAttempt: (attemptId) => ({
      attemptId,
      role: 'developer',
      harness: 'pi',
      provider: 'llamacpp',
      model: 'qwen3.8-27b',
    }),
    submit: async () => {
      submitted = true;
      return { accepted: true };
    },
  });

  await assert.rejects(
    () => tool.execute('call-2', {
      attemptId: 'attempt-2',
      outcome: 'PASS',
      summary: 'done',
    }),
    /only valid for Ariad role attempts running on the Codex harness/,
  );
  assert.equal(submitted, false);
});

test('ariad_codex_role_result validates outcome against the bound role', async () => {
  let submitted = false;
  const { tool } = captureRegisteredTool({
    resolveAttempt: (attemptId) => ({
      attemptId,
      role: 'tech_lead',
      harness: 'codex',
    }),
    submit: async () => {
      submitted = true;
      return { accepted: true };
    },
  });

  await assert.rejects(
    () => tool.execute('call-3', {
      attemptId: 'attempt-3',
      outcome: 'PASS',
      summary: 'wrong outcome for tech lead',
    }),
    /invalid tech_lead outcome/,
  );
  assert.equal(submitted, false);
});

test('OpenClawRuntimeAdapter records the actual Codex runtime against the Ariad attempt', async () => {
  const adapter = new OpenClawRuntimeAdapter({
    subagent: {
      async run(input) {
        return {
          runId: 'openclaw-run-1',
          sessionKey: input.sessionKey,
          runtime: {
            harness: 'codex',
            provider: 'openai',
            model: 'gpt-5.6-terra',
          },
        };
      },
      async waitForRun() {
        return { status: 'timeout' };
      },
    },
  });

  await adapter.start({
    runId: 'ariad-run-1',
    role: 'tech_lead',
    context: {
      projectId: 'project-1',
      taskId: 'planning-1',
      attemptId: 'attempt-4',
    },
  });

  assert.deepEqual(adapter.getAttemptRuntimeBinding('attempt-4'), {
    projectId: 'project-1',
    taskId: 'planning-1',
    attemptId: 'attempt-4',
    role: 'tech_lead',
    externalId: 'openclaw-run-1',
    harness: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-terra',
  });
});
