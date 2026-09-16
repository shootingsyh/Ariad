const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRuntimeAdapter,
  RuntimeAdapterError,
} = require('../src/runtime-adapter');
const { createFakeRuntimeAdapter } = require('../src/adapters/fake-runtime');

test('runtime adapter contract requires a stable id and lifecycle methods', () => {
  assert.throws(
    () => validateRuntimeAdapter({ id: 'broken' }),
    (error) => error instanceof RuntimeAdapterError && /start/.test(error.message),
  );
});

test('fake runtime adapter conforms to the runtime contract', () => {
  const runtime = createFakeRuntimeAdapter();
  assert.equal(validateRuntimeAdapter(runtime), runtime);
  assert.equal(runtime.id, 'fake');
});

test('adapter start returns a normalized run handle', async () => {
  const runtime = createFakeRuntimeAdapter({
    script: [{ outcome: 'PASS', result: { artifact: 'build-1' } }],
  });

  const run = await runtime.start({
    runId: 'R-1',
    role: 'developer',
    task: { id: 'T-1' },
    context: { checkpoint: null },
  });

  assert.deepEqual(run, {
    runtimeId: 'fake',
    runId: 'R-1',
    externalId: 'fake:R-1',
    state: 'RUNNING',
  });

  const result = await runtime.poll(run);
  assert.deepEqual(result, {
    state: 'COMPLETED',
    outcome: 'PASS',
    result: { artifact: 'build-1' },
  });
});

test('adapter supports resume without requiring workflow core to know runtime details', async () => {
  const runtime = createFakeRuntimeAdapter({
    script: [{ outcome: 'PASS', result: { resumed: true } }],
  });

  const run = await runtime.resume({
    runId: 'R-2',
    role: 'developer',
    task: { id: 'T-2' },
    checkpoint: { id: 'CP-9' },
    context: {},
  });

  assert.equal(run.externalId, 'fake:R-2');
  assert.deepEqual(runtime.calls[0], {
    operation: 'resume',
    runId: 'R-2',
    checkpoint: { id: 'CP-9' },
  });
});

test('adapter cancellation is normalized', async () => {
  const runtime = createFakeRuntimeAdapter();
  const run = await runtime.start({ runId: 'R-3', role: 'tester', task: { id: 'T-3' }, context: {} });

  const result = await runtime.cancel(run);
  assert.deepEqual(result, { state: 'CANCELLED' });
});

test('runtime-specific configuration remains opaque to core', () => {
  const runtime = createFakeRuntimeAdapter({
    config: {
      endpoint: 'http://localhost:1234',
      model: 'qwen-local',
      vendorSpecificFlag: true,
    },
  });

  assert.deepEqual(runtime.config, {
    endpoint: 'http://localhost:1234',
    model: 'qwen-local',
    vendorSpecificFlag: true,
  });
  assert.equal(validateRuntimeAdapter(runtime), runtime);
});
