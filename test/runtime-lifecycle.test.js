import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRuntimeAdapter } from '../src/runtime-adapter.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';
import { RuntimeMonitor } from '../src/runtime-monitor.js';

test('runtime adapter contract requires install and probe lifecycle methods', () => {
  const adapter = createFakeRuntimeAdapter();
  assert.equal(validateRuntimeAdapter(adapter), adapter);
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.probe, 'function');
});

test('fake runtime install is idempotent and records installation state', async () => {
  const adapter = createFakeRuntimeAdapter();
  const first = await adapter.install({ runtimeKey: 'local_execution' });
  const second = await adapter.install({ runtimeKey: 'local_execution' });
  assert.equal(first.state, 'INSTALLED');
  assert.equal(second.state, 'INSTALLED');
  assert.equal(adapter.installCount, 1);
});

test('runtime monitor polls probe asynchronously and emits health changes', async () => {
  const adapter = createFakeRuntimeAdapter({ healthScript: ['HEALTHY', 'HEALTHY', 'UNHEALTHY'] });
  await adapter.install({ runtimeKey: 'fake' });
  const events = [];
  const monitor = new RuntimeMonitor({ adapter, intervalMs: 5, emit: event => events.push(event) });
  monitor.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  await monitor.stop();
  assert.ok(events.some(event => event.type === 'RUNTIME_HEALTH_CHANGED' && event.health === 'HEALTHY'));
  assert.ok(events.some(event => event.type === 'RUNTIME_HEALTH_CHANGED' && event.health === 'UNHEALTHY'));
  assert.equal(monitor.running, false);
});

test('runtime monitor does not emit duplicate events while health is unchanged', async () => {
  const adapter = createFakeRuntimeAdapter({ healthScript: ['HEALTHY', 'HEALTHY', 'HEALTHY'] });
  const events = [];
  const monitor = new RuntimeMonitor({ adapter, intervalMs: 5, emit: event => events.push(event) });
  monitor.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  await monitor.stop();
  assert.equal(events.filter(event => event.type === 'RUNTIME_HEALTH_CHANGED').length, 1);
});

test('probe failure becomes a monitor observation instead of crashing the monitor loop', async () => {
  const adapter = createFakeRuntimeAdapter({ probeErrors: [new Error('probe exploded')] });
  const events = [];
  const monitor = new RuntimeMonitor({ adapter, intervalMs: 5, emit: event => events.push(event) });
  monitor.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  await monitor.stop();
  assert.ok(events.some(event => event.type === 'RUNTIME_PROBE_FAILED'));
  assert.equal(monitor.running, false);
});
