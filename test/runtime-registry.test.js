const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeRegistry } = require('../src/runtime-registry');
const { createFakeRuntimeAdapter } = require('../src/adapters/fake-runtime');

test('runtime registry resolves a logical runtime key to an adapter', () => {
  const registry = new RuntimeRegistry();
  const adapter = createFakeRuntimeAdapter();

  registry.register('local_execution', adapter);

  assert.equal(registry.get('local_execution'), adapter);
});

test('runtime registry validates adapters on registration', () => {
  const registry = new RuntimeRegistry();
  assert.throws(() => registry.register('broken', { id: 'broken' }), /start/);
});

test('runtime registry rejects duplicate logical keys unless explicitly replaced', () => {
  const registry = new RuntimeRegistry();
  registry.register('execution', createFakeRuntimeAdapter());

  assert.throws(
    () => registry.register('execution', createFakeRuntimeAdapter()),
    /already registered/,
  );

  const replacement = createFakeRuntimeAdapter({ config: { version: 2 } });
  registry.register('execution', replacement, { replace: true });
  assert.equal(registry.get('execution'), replacement);
});

test('unknown runtime key fails before dispatch', () => {
  const registry = new RuntimeRegistry();
  assert.throws(() => registry.get('missing'), /unknown runtime/);
});
