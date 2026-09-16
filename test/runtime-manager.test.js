import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeRegistry } from '../src/runtime-registry.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';
import { RuntimeManager } from '../src/runtime-manager.js';

test('runtime manager installs, probes, then starts monitors in order', async () => {
  const events = [];
  const registry = new RuntimeRegistry();
  const fake = createFakeRuntimeAdapter({
    onInstall: async () => events.push('install'),
    healthScript: ['HEALTHY'],
  });
  registry.register('fake', fake);

  const manager = new RuntimeManager({
    registry,
    monitorFactory: ({ adapter }) => ({
      async start() { events.push(`monitor:start:${adapter.id}`); },
      async stop() { events.push(`monitor:stop:${adapter.id}`); },
    }),
  });

  await manager.start();
  assert.deepEqual(events.slice(0, 2), ['install', 'monitor:start:fake']);
  assert.equal(manager.getStatus('fake').health, 'HEALTHY');
  await manager.stop();
  assert.equal(events.at(-1), 'monitor:stop:fake');
});

test('runtime manager does not start monitors when install fails', async () => {
  let monitorStarted = false;
  const registry = new RuntimeRegistry();
  registry.register('fake', createFakeRuntimeAdapter({ installError: new Error('install failed') }));
  const manager = new RuntimeManager({
    registry,
    monitorFactory: () => ({ async start() { monitorStarted = true; }, async stop() {} }),
  });
  await assert.rejects(() => manager.start(), /install failed/);
  assert.equal(monitorStarted, false);
});

test('runtime manager stop is idempotent', async () => {
  let stopCalls = 0;
  const registry = new RuntimeRegistry();
  registry.register('fake', createFakeRuntimeAdapter());
  const manager = new RuntimeManager({
    registry,
    monitorFactory: () => ({ async start() {}, async stop() { stopCalls += 1; } }),
  });
  await manager.start();
  await manager.stop();
  await manager.stop();
  assert.equal(stopCalls, 1);
});

test('runtime manager exposes installed runtime status snapshots', async () => {
  const registry = new RuntimeRegistry();
  registry.register('fake', createFakeRuntimeAdapter({ healthScript: ['DEGRADED'] }));
  const manager = new RuntimeManager({ registry, monitorFactory: () => ({ async start() {}, async stop() {} }) });
  await manager.start();
  assert.deepEqual(manager.listStatus(), [{ key: 'fake', runtimeId: 'fake', health: 'DEGRADED' }]);
});
