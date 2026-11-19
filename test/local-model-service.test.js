import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ensureLocalModelService, isValidLocalModelServiceUnit } from '../src/runtime/local-model-service.js';

const BASE = 'http://127.0.0.1:18080/v1';
const UNIT = 'openclaw-llama.service';

test('unit name validation accepts plain unit names and rejects shell-shaped input', () => {
  assert.equal(isValidLocalModelServiceUnit(UNIT), true);
  assert.equal(isValidLocalModelServiceUnit('llama.service'), true);
  assert.equal(isValidLocalModelServiceUnit('foo; rm -rf /'), false);
  assert.equal(isValidLocalModelServiceUnit('a b'), false);
  assert.equal(isValidLocalModelServiceUnit(''), false);
  assert.equal(isValidLocalModelServiceUnit(null), false);
  assert.equal(isValidLocalModelServiceUnit(undefined), false);
});

test('an already-up endpoint is left alone', async () => {
  let starts = 0;
  const result = await ensureLocalModelService({
    baseUrl: BASE, serviceUnit: UNIT,
    probe: async () => ({ reachable: true }),
    startService: async () => { starts += 1; },
  });
  assert.equal(result.status, 'already-up');
  assert.equal(starts, 0);
});

test('a down endpoint is started and awaited until reachable', async () => {
  let probes = 0;
  let startedWith = null;
  const result = await ensureLocalModelService({
    baseUrl: BASE, serviceUnit: UNIT,
    probe: async () => { probes += 1; return { reachable: probes >= 3 }; },
    startService: async unit => { startedWith = unit; },
    sleep: async () => {},
    timeoutMs: 60000, intervalMs: 1,
  });
  assert.equal(result.status, 'started');
  assert.equal(startedWith, UNIT);
});

test('an endpoint that never comes up times out without throwing', async () => {
  const result = await ensureLocalModelService({
    baseUrl: BASE, serviceUnit: UNIT,
    probe: async () => ({ reachable: false, error: 'refused' }),
    startService: async () => {},
    sleep: async () => {},
    timeoutMs: 20, intervalMs: 1,
  });
  assert.equal(result.status, 'timeout');
});

test('a start failure is reported, never thrown', async () => {
  const result = await ensureLocalModelService({
    baseUrl: BASE, serviceUnit: UNIT,
    probe: async () => ({ reachable: false, error: 'refused' }),
    startService: async () => { throw new Error('systemctl missing'); },
  });
  assert.equal(result.status, 'start-failed');
  assert.match(result.reason, /systemctl missing/);
});

test('a missing or invalid unit is skipped without probing', async () => {
  let probes = 0;
  const result = await ensureLocalModelService({
    baseUrl: BASE, serviceUnit: 'bad unit!',
    probe: async () => { probes += 1; return { reachable: true }; },
    startService: async () => {},
  });
  assert.equal(result.status, 'skipped');
  assert.equal(probes, 0);
});
