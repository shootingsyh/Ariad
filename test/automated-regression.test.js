import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverFocusedTests, readAutomatedRegression, regressionReportPath, runAutomatedRegression } from '../src/runtime/automated-regression.js';

test('focused discovery uses developer-owned test artifacts only', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-regression-discovery-'));
  mkdirSync(join(root, 'tests'));
  for (const name of ['test_focus.gd', 'test_other.gd', 'helper.gd']) writeFileSync(join(root, 'tests', name), '# fixture\n');
  const tests = discoverFocusedTests({ workspace: root, developerResult: {
    artifacts: ['scripts/feature.gd', 'tests/test_focus.gd', 'tests/helper.gd', 'missing/test_missing.gd'],
    keyPoints: ['full regression tests/test_other.gd also passed'],
    result: { interfaceRealizations: [{ interfaceId: 'feature', anchors: [{ file: 'tests/test_focus.gd' }] }] },
  }});
  assert.deepEqual(tests, ['tests/test_focus.gd']);
});

test('runner writes a structured PASS report', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-regression-run-'));
  const artifacts = join(root, '.ariad', 'artifacts');
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'tests', 'test_focus.gd'), '# fixture\n');
  const fakeGodot = join(root, 'bin', 'godot');
  writeFileSync(fakeGodot, '#!/bin/sh\necho "TEST_FOCUS ALL PASS (3/3)"\nexit 0\n');
  chmodSync(fakeGodot, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${priorPath}`;
  try {
    const report = runAutomatedRegression({
      workspace: root, artifactRoot: artifacts,
      task: { id: 'focus-task', verification: [{ criterionId: 'AC1', mode: 'runtime', target: 'fixture' }] },
      developerResult: { artifacts: ['tests/test_focus.gd'] }, timeoutMs: 5000,
    });
    assert.equal(report.summary.status, 'PASS');
    assert.equal(report.summary.discovered, 1);
    assert.equal(report.tests[0].test, 'tests/test_focus.gd');
    assert.match(report.tests[0].outputTail, /ALL PASS/);
    assert.equal(readAutomatedRegression(artifacts, 'focus-task').summary.passed, 1);
    assert.equal(JSON.parse(readFileSync(regressionReportPath(artifacts, 'focus-task'), 'utf8')).schema, 'ariad-automated-regression-v1');
  } finally { process.env.PATH = priorPath; }
});
