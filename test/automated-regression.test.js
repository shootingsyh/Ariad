import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { discoverCiTests, readAutomatedRegression, regressionReportPath, runAutomatedRegression } from '../src/runtime/automated-regression.js';

function initRepo(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
}

test('two-level locality discovery selects only exact leaf and parent-folder CI tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-regression-discovery-'));
  initRepo(root);
  mkdirSync(join(root, 'scripts', 'policies', '__tests__'), { recursive: true });
  mkdirSync(join(root, 'scripts', '__tests__'), { recursive: true });
  mkdirSync(join(root, '__tests__'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'policies', 'retreat_policy.gd'), 'extends RefCounted\n');
  writeFileSync(join(root, 'scripts', 'policies', '__tests__', 'retreat_policy__test.gd'), '# leaf\n');
  writeFileSync(join(root, 'scripts', 'policies', '__tests__', 'sibling__test.gd'), '# sibling\n');
  writeFileSync(join(root, 'scripts', '__tests__', 'policies__test.gd'), '# folder\n');
  writeFileSync(join(root, '__tests__', 'scripts__test.gd'), '# too broad\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  writeFileSync(join(root, 'scripts', 'policies', 'retreat_policy.gd'), 'extends RefCounted\n# changed\n');

  const found = discoverCiTests({ workspace: root });
  assert.deepEqual(found.artifacts, ['scripts/policies/retreat_policy.gd']);
  assert.deepEqual(found.tests, [
    'scripts/policies/__tests__/retreat_policy__test.gd',
    'scripts/__tests__/policies__test.gd',
  ]);
  assert.deepEqual(found.coverageGaps, []);
});

test('locality discovery reports a coverage gap instead of climbing or scanning siblings', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-regression-gap-'));
  initRepo(root);
  mkdirSync(join(root, 'data', 'maps', '__tests__'), { recursive: true });
  mkdirSync(join(root, '__tests__'), { recursive: true });
  writeFileSync(join(root, 'data', 'maps', 'ch06.json'), '{}\n');
  writeFileSync(join(root, 'data', 'maps', '__tests__', 'ch05__test.gd'), '# sibling\n');
  writeFileSync(join(root, '__tests__', 'data__test.gd'), '# broad\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  writeFileSync(join(root, 'data', 'maps', 'ch06.json'), '{"changed":true}\n');

  const found = discoverCiTests({ workspace: root });
  assert.deepEqual(found.tests, []);
  assert.deepEqual(found.coverageGaps, ['data/maps/ch06.json']);
});

test('runner persists two-level CI report', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-regression-run-'));
  const artifacts = join(root, '.ariad', 'artifacts');
  initRepo(root);
  mkdirSync(join(root, 'scripts', 'policies', '__tests__'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'policies', 'retreat_policy.gd'), 'extends RefCounted\n');
  writeFileSync(join(root, 'scripts', 'policies', '__tests__', 'retreat_policy__test.gd'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  writeFileSync(join(root, 'scripts', 'policies', 'retreat_policy.gd'), 'extends RefCounted\n# changed\n');
  symlinkSync('/bin/true', join(root, 'bin', 'godot'));

  const priorPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${priorPath}`;
  try {
    const report = runAutomatedRegression({
      workspace: root,
      artifactRoot: artifacts,
      task: { id: 'focus-task', verification: [] },
      timeoutMs: 5000,
    });
    assert.equal(report.summary.status, 'PASS');
    assert.equal(report.summary.discovered, 1);
    assert.equal(report.tests[0].test, 'scripts/policies/__tests__/retreat_policy__test.gd');
    assert.equal(readAutomatedRegression(artifacts, 'focus-task').summary.passed, 1);
    assert.equal(JSON.parse(readFileSync(regressionReportPath(artifacts, 'focus-task'), 'utf8')).schema, 'ariad-automated-regression-v2');
  } finally {
    process.env.PATH = priorPath;
  }
});
