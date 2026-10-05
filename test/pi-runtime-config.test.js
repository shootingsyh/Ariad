import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import {
  ARIAD_PI_DEFAULT_TOOLS,
  ARIAD_PI_SPECIAL_NEEDS,
  ariadPiPaths,
  buildAriadPiModelsConfig,
  buildAriadPiSessionConfig,
  createAriadPiTerminalTool,
  resolveAriadPiModelRef,
} from '../src/runtime/pi-runtime-config.js';
import {
  piRoleResultToolSchema,
  piSessionManagerForSpec,
} from '../src/runtime/pi-agent-session-provider.js';

test('Ariad bundles the Pi coding-agent SDK surface it depends on', () => {
  assert.equal(typeof createAgentSession, 'function');
  assert.equal(typeof ModelRuntime.create, 'function');
  assert.equal(typeof SessionManager.inMemory, 'function');
});

test('Ariad Pi model refs preserve production policy without fallback', () => {
  assert.deepEqual(resolveAriadPiModelRef('openai/gpt-5.6-terra'), {
    ariadRef: 'openai/gpt-5.6-terra',
    provider: 'openai',
    model: 'gpt-5.6-terra',
    auth: 'OPENAI_API_KEY-or-pi-auth',
  });
  assert.deepEqual(resolveAriadPiModelRef('openai-codex/gpt-5.6-terra'), {
    ariadRef: 'openai-codex/gpt-5.6-terra',
    provider: 'openai-codex',
    model: 'gpt-5.6-terra',
    auth: 'subscription-or-pi-auth',
  });
  assert.deepEqual(resolveAriadPiModelRef('meta/muse-spark-1.1'), {
    ariadRef: 'meta/muse-spark-1.1',
    provider: 'meta',
    model: 'muse-spark-1.1',
    auth: 'META_API_KEY-or-pi-auth',
  });
  assert.deepEqual(resolveAriadPiModelRef('llamacpp/qwen3.8-27b'), {
    ariadRef: 'llamacpp/qwen3.8-27b',
    provider: 'llamacpp',
    model: 'qwen3.8-27b',
    auth: 'none',
  });
  assert.throws(
    () => resolveAriadPiModelRef('unknown/model'),
    /MODEL_PROVIDER_UNAVAILABLE/,
  );
});

test('Ariad generates local llama.cpp provider configuration from role models', () => {
  const config = buildAriadPiModelsConfig({
    developer: 'llamacpp/qwen3.8-27b',
    tester: 'llamacpp/qwen3.8-27b',
    tech_lead: 'openai/gpt-5.6-terra',
  }, { llamaCppBaseUrl: 'http://127.0.0.1:18080/v1' });

  assert.equal(config.providers.llamacpp.baseUrl, 'http://127.0.0.1:18080/v1');
  assert.equal(config.providers.llamacpp.api, 'openai-completions');
  assert.deepEqual(
    config.providers.llamacpp.models.map(model => model.id),
    ['qwen3.8-27b'],
  );
});

test('Pi ModelRuntime contains Codex and Meta providers and consumes Ariad local config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pi-models-'));
  try {
    const authPath = path.join(root, 'auth.json');
    const modelsPath = path.join(root, 'models.json');
    fs.writeFileSync(authPath, '{}\n');
    fs.writeFileSync(modelsPath, JSON.stringify(buildAriadPiModelsConfig({
      developer: 'llamacpp/qwen3.8-27b',
    }), null, 2));

    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });

    assert.ok(runtime.getProvider('openai'), 'Pi must bundle OpenAI API provider');
    assert.ok(runtime.getProvider('openai-codex'), 'Pi must bundle Codex subscription provider');
    assert.ok(runtime.getProvider('meta'), 'Pi must bundle Meta provider');
    assert.ok(runtime.getModel('llamacpp', 'qwen3.8-27b'), 'Ariad local model config must load');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Ariad Pi sessions enable coding tools and persistent-session coordinates', () => {
  const workspace = '/tmp/demo';
  const config = buildAriadPiSessionConfig({
    workspace,
    role: 'tech_lead',
    modelRef: 'openai-codex/gpt-5.6-terra',
    roleModels: { tech_lead: 'openai-codex/gpt-5.6-terra' },
    sessionPolicy: 'persistent',
    sessionKey: 'tl:demo',
  });

  assert.deepEqual(config.tools, [...ARIAD_PI_DEFAULT_TOOLS]);
  assert.equal(config.model.provider, 'openai-codex');
  assert.equal(config.sessionKey, 'tl:demo');
  assert.deepEqual(config.paths, ariadPiPaths(workspace));
});

test('Ariad terminal result tool cleanly terminates a Pi tool batch', async () => {
  let submitted = null;
  const tool = createAriadPiTerminalTool({
    name: 'ariad_tech_lead_result',
    parameters: Type.Object({
      outcome: Type.String(),
      summary: Type.String(),
    }),
    submit: async payload => {
      submitted = payload;
      return { accepted: true };
    },
  });

  const result = await tool.execute('call-1', {
    outcome: 'PLANNED',
    summary: 'done',
  });

  assert.deepEqual(submitted, { outcome: 'PLANNED', summary: 'done' });
  assert.equal(result.terminate, true);
  assert.equal(result.details.accepted, true);
});

test('special-needs contract documents the OC-replacement capabilities Pi owns', () => {
  assert.equal(ARIAD_PI_SPECIAL_NEEDS.headlessSession, 'createAgentSession');
  assert.equal(ARIAD_PI_SPECIAL_NEEDS.cancellation, 'AgentSession.abort');
  assert.equal(ARIAD_PI_SPECIAL_NEEDS.terminalStructuredResult.includes('terminate=true'), true);
  assert.deepEqual(ARIAD_PI_SPECIAL_NEEDS.hostedProviders, ['openai', 'openai-codex', 'meta']);
  assert.equal(ARIAD_PI_SPECIAL_NEEDS.providerFallback, false);
});


test('Pi role result tool preserves Ariad strict role outcomes and structured delivery payloads', () => {
  const developer = piRoleResultToolSchema('developer');
  assert.deepEqual(
    developer.properties.outcome.anyOf.map(item => item.const),
    ['PASS', 'NOT_PASS'],
  );
  assert.equal(developer.properties.result.type, 'object');
  assert.equal(
    developer.properties.result.properties.interfaceRealizations.type,
    'array',
  );

  const tester = piRoleResultToolSchema('tester');
  assert.deepEqual(
    tester.properties.outcome.anyOf.map(item => item.const),
    ['PASS', 'NOT_PASS'],
  );
  assert.equal(tester.properties.result.type, 'object');
  assert.equal(tester.properties.result.properties.criteria.type, 'array');
  assert.equal(tester.properties.result.properties.interfaceVerifications.type, 'array');

  const reviewer = piRoleResultToolSchema('reviewer');
  assert.equal(reviewer.properties.result.type, 'object');
  assert.equal(reviewer.properties.result.properties.interfaceReviews.type, 'array');
});


test('persistent Pi role sessions resume by session key while fresh roles are isolated and persisted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pi-session-policy-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const paths = ariadPiPaths(workspace);

  try {
    const first = piSessionManagerForSpec({
      role: 'pm',
      sessionPolicy: 'persistent',
      sessionKey: 'pm:P-session',
    }, paths, workspace);
    first.appendMessage({
      role: 'user',
      content: 'remember persistent-token-123',
      timestamp: Date.now(),
    });
    const firstFile = first.getSessionFile();
    assert.ok(firstFile);

    const resumed = piSessionManagerForSpec({
      role: 'pm',
      sessionPolicy: 'persistent',
      sessionKey: 'pm:P-session',
    }, paths, workspace);
    assert.equal(resumed.getSessionFile(), firstFile);
    assert.equal(
      resumed.buildSessionContext().messages.some(message =>
        message.role === 'user'
        && typeof message.content === 'string'
        && message.content.includes('persistent-token-123')),
      true,
    );

    const isolated = piSessionManagerForSpec({
      role: 'tech_lead',
      sessionPolicy: 'persistent',
      sessionKey: 'tl:P-session',
    }, paths, workspace);
    assert.notEqual(isolated.getSessionDir(), resumed.getSessionDir());
    assert.equal(isolated.buildSessionContext().messages.length, 0);

    const fresh = piSessionManagerForSpec({
      projectId: 'P-session',
      taskId: 'T-fresh',
      attemptId: 'P-session:T-fresh:developer:1',
      role: 'developer',
      sessionPolicy: 'fresh',
    }, paths, workspace);
    fresh.appendMessage({
      role: 'user',
      content: 'fresh-token',
      timestamp: Date.now(),
    });
    assert.ok(fresh.getSessionFile());
    const freshAgain = piSessionManagerForSpec({
      projectId: 'P-session',
      taskId: 'T-fresh',
      attemptId: 'P-session:T-fresh:developer:2',
      role: 'developer',
      sessionPolicy: 'fresh',
    }, paths, workspace);
    assert.notEqual(freshAgain.getSessionDir(), fresh.getSessionDir());
    assert.equal(freshAgain.buildSessionContext().messages.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
