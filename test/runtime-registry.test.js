import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeRegistry } from '../src/runtime-registry.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';

test('runtime registry resolves a logical runtime key to an adapter', () => {
  const registry = new RuntimeRegistry();
  const adapter = createFakeRuntimeAdapter();
  registry.register('local_execution', adapter);
  assert.equal(registry.get('local_execution'), adapter);
});

test('runtime registry validates adapters on registration', () => {
  const registry = new RuntimeRegistry();
  assert.throws(() => registry.register('broken', { id: 'broken' }), /install/);
});

test('runtime registry rejects duplicate logical keys unless explicitly replaced', () => {
  const registry = new RuntimeRegistry();
  registry.register('execution', createFakeRuntimeAdapter());
  assert.throws(() => registry.register('execution', createFakeRuntimeAdapter()), /already registered/);
  const replacement = createFakeRuntimeAdapter({ config: { version: 2 } });
  registry.register('execution', replacement, { replace: true });
  assert.equal(registry.get('execution'), replacement);
});

test('unknown runtime key fails before dispatch', () => {
  const registry = new RuntimeRegistry();
  assert.throws(() => registry.get('missing'), /unknown runtime/);
});
