import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runConfigAssistant,
  parseAssistantAction,
  stripAssistantAction,
} from '../src/runtime/config-assistant.js';

const ALL_REFS = Object.fromEntries(
  ['tech_lead', 'tech_lead_critic', 'pm', 'developer', 'tester', 'reviewer', 'artist', 'project_debugger']
    .map(role => [role, 'mycloud/qwen3.8-27b']),
);

function fence(action) {
  return '```ariad-action\n' + JSON.stringify(action) + '\n```';
}

function fakeIo({ inputs = [], confirms = [], secret = '' } = {}) {
  const printed = [];
  return {
    printed,
    print: line => printed.push(String(line)),
    input: async () => inputs.shift() ?? '/done',
    confirm: async () => confirms.shift() ?? false,
    secret: async () => secret,
  };
}

function fakeService(overrides = {}) {
  const calls = { savedRoles: [], savedKeys: [], providers: [] };
  const service = {
    snapshot: async () => ({ customProviders: [], roleDefaults: null, readiness: { providers: {} } }),
    configuredProviders: () => [{ id: 'mycloud', source: 'pi-auth' }],
    listProviderModels: async () => [{ id: 'qwen3.8-27b', cost: { input: 0, output: 0 } }],
    validateRoleModels: async roleModels => ({
      complete: Object.keys(roleModels).length === 8,
      completenessError: Object.keys(roleModels).length === 8 ? null : 'missing roles',
      roles: Object.fromEntries(Object.entries(roleModels).map(([role, ref]) => [role, {
        ref, ok: !String(ref).includes('bogus'), reason: 'MODEL_NOT_FOUND',
        provider: String(ref).split('/')[0], cost: { input: 0, output: 0 },
      }])),
    }),
    setRoleDefaults: roleModels => { calls.savedRoles.push(roleModels); return roleModels; },
    saveApiKey: (providerId, key) => { calls.savedKeys.push({ providerId, key }); },
    upsertCustomProvider: (id, entry) => { calls.providers.push({ id, entry }); return { saved: true }; },
    ...overrides,
  };
  return { service, calls };
}

function scriptedComplete(replies, prompts) {
  return async prompt => {
    prompts.push(prompt);
    return replies.shift() ?? fence({ action: 'finish' });
  };
}

test('assistant: a validated proposal is applied only after the user confirms', async () => {
  const { service, calls } = fakeService();
  const prompts = [];
  const complete = scriptedComplete([
    `这组搭配性价比最高。\n${fence({ action: 'propose_role_models', roleModels: ALL_REFS })}`,
    fence({ action: 'finish' }),
  ], prompts);
  const io = fakeIo({ confirms: [true] });
  const result = await runConfigAssistant({ service, io, complete, igniterRef: 'mycloud/qwen3.8-27b' });
  assert.deepEqual(calls.savedRoles, [ALL_REFS]);
  assert.deepEqual(result.applied, ['role-models']);
  assert.match(prompts[1], /已保存/, 'the save outcome is fed back to the model');
});

test('assistant: rejection and invalid refs never reach the store', async () => {
  const { service, calls } = fakeService();
  const prompts = [];
  const bogus = { ...ALL_REFS, pm: 'mycloud/bogus-1' };
  const complete = scriptedComplete([
    fence({ action: 'propose_role_models', roleModels: bogus }),
    fence({ action: 'propose_role_models', roleModels: ALL_REFS }),
    fence({ action: 'finish' }),
  ], prompts);
  const io = fakeIo({ confirms: [false] });
  const result = await runConfigAssistant({ service, io, complete, igniterRef: 'mycloud/qwen3.8-27b' });
  assert.equal(calls.savedRoles.length, 0);
  assert.deepEqual(result.applied, []);
  assert.match(prompts[1], /验证失败/, 'validation failure is fed back without asking the user');
  assert.match(prompts[2], /拒绝/, 'the user rejection is fed back for a revised proposal');
});

test('assistant: API keys go from the local secret prompt to the store, never to the model', async () => {
  const { service, calls } = fakeService();
  const prompts = [];
  const complete = scriptedComplete([
    fence({ action: 'request_api_key', providerId: 'openai' }),
    fence({ action: 'finish' }),
  ], prompts);
  const io = fakeIo({ secret: 'sk-super-secret-value' });
  await runConfigAssistant({ service, io, complete, igniterRef: 'mycloud/qwen3.8-27b' });
  assert.deepEqual(calls.savedKeys, [{ providerId: 'openai', key: 'sk-super-secret-value' }]);
  for (const prompt of prompts) {
    assert.equal(prompt.includes('sk-super-secret-value'), false, 'the key must never appear in a model prompt');
  }
  assert.match(prompts[1], /key 已由用户在本地输入并保存/);
});

test('assistant: provider proposals, malformed actions, and the turn cap all degrade cleanly', async () => {
  const { service, calls } = fakeService();
  const prompts = [];
  const complete = scriptedComplete([
    '```ariad-action\n{not json\n```',
    fence({ action: 'propose_provider', id: 'local', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'llama3' }] }),
    '闲聊一句，没有动作。',
    '继续闲聊。',
  ], prompts);
  const io = fakeIo({ confirms: [true], inputs: ['你好', '/done'] });
  const result = await runConfigAssistant({ service, io, complete, igniterRef: 'mycloud/qwen3.8-27b', maxTurns: 4 });
  assert.deepEqual(calls.providers.map(p => p.id), ['local']);
  assert.match(prompts[1], /不是合法 JSON/);
  assert.deepEqual(result.applied, ['provider:local']);
});

test('action parsing: fences are found and stripped from display text', () => {
  const text = `好的。\n${fence({ action: 'finish' })}`;
  assert.deepEqual(parseAssistantAction(text), { action: 'finish' });
  assert.equal(stripAssistantAction(text), '好的。');
  assert.equal(parseAssistantAction('纯聊天'), null);
});
