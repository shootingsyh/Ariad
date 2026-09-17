import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManagedComponent, validateHostLifecycle } from '../src/host-lifecycle.js';
import { validateProjectAgentAdapter } from '../src/project-agent-adapter.js';

test('host lifecycle is a substrate seam rather than an OpenClaw dependency', () => {
  const component = validateManagedComponent({ async start() {}, async stop() {} });
  const registered = [];
  const host = validateHostLifecycle({ register(value) { registered.push(value); } });
  host.register(component);
  assert.deepEqual(registered, [component]);
});

test('project agent adapter is distinct from host lifecycle and runtime execution', () => {
  const adapter = validateProjectAgentAdapter({
    id: 'fake-project-agent',
    async bindProject() {},
    async notify() {},
    async submitDecision() {},
  });
  assert.equal(adapter.id, 'fake-project-agent');
  assert.throws(() => validateProjectAgentAdapter({ id: 'bad' }), /bindProject/);
});
