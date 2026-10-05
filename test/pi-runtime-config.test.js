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

test('Ariad bundles the Pi coding-agent SDK surface it depends on', () => {
  assert.equal(typeof createAgentSession, 'function');
  assert.equal(typeof ModelRuntime.create, 'function');
  assert.equal(typeof SessionManager.inMemory, 'function');
});

test('Ariad Pi model refs preserve production policy without fallback', () => {
  assert.deepEqual(resolveAriadPiModelRef('openai/gpt-5.6-terra'), {
    ariadRef: 'openai/gpt-5.6-terra',
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
    modelRef: 'openai/gpt-5.6-terra',
    roleModels: { tech_lead: 'openai/gpt-5.6-terra' },
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
  assert.deepEqual(ARIAD_PI_SPECIAL_NEEDS.hostedProviders, ['openai-codex', 'meta']);
  assert.equal(ARIAD_PI_SPECIAL_NEEDS.providerFallback, false);
});
