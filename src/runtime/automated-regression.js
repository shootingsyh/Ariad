import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function uniq(items) { return [...new Set(items)]; }

export function discoverFocusedTests({ workspace, developerResult }) {
  const found = [];
  const sources = [
    ...(developerResult?.artifacts ?? []),
    ...(developerResult?.result?.interfaceRealizations ?? []).flatMap(item =>
      (item?.anchors ?? []).map(anchor => anchor?.file ?? '')
    ),
  ];
  for (const raw of sources) {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    const matches = text.matchAll(/(?:^|[\s"'(])((?:tests)\/[A-Za-z0-9_.\/-]+\.gd)\b/g);
    for (const match of matches) {
      const rel = match[1];
      const base = rel.split('/').at(-1) ?? '';
      if (!base.startsWith('test_')) continue;
      if (existsSync(resolve(workspace, rel))) found.push(rel);
    }
  }
  return uniq(found).slice(0, 8);
}

function tail(text, lines = 60) {
  return String(text ?? '').split(/\r?\n/).slice(-lines).join('\n');
}

function safeTaskId(taskId) {
  return String(taskId ?? 'task').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96);
}

export function regressionReportPath(artifactRoot, taskId) {
  return join(artifactRoot, 'regression', `${safeTaskId(taskId)}.json`);
}

export function readAutomatedRegression(artifactRoot, taskId) {
  if (!artifactRoot || !taskId) return null;
  const path = regressionReportPath(artifactRoot, taskId);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

export function runAutomatedRegression({ workspace, artifactRoot, task, developerResult, timeoutMs = 300000 }) {
  if (!workspace || !artifactRoot || !task?.id) return null;
  const tests = discoverFocusedTests({ workspace, developerResult });
  const results = [];
  for (const rel of tests) {
    const started = Date.now();
    let ok = false;
    let output = '';
    let failure = null;
    try {
      output = execFileSync('godot', [
        '--headless', '--audio-driver', 'Dummy', '--path', workspace,
        '-s', `res://${rel}`,
      ], {
        cwd: workspace,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
      ok = true;
    } catch (error) {
      output = `${error?.stdout?.toString?.() ?? ''}\n${error?.stderr?.toString?.() ?? ''}`;
      failure = error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (error?.message ?? String(error));
    }
    results.push({
      test: rel,
      status: ok ? 'PASS' : 'FAIL',
      durationMs: Date.now() - started,
      outputTail: tail(output),
      ...(failure ? { failure } : {}),
    });
  }

  const report = {
    schema: 'ariad-automated-regression-v1',
    taskId: task.id,
    generatedAt: new Date().toISOString(),
    source: 'developer-artifacts',
    verificationTargets: structuredClone(task.verification ?? task.input?.verification ?? []),
    tests: results,
    summary: {
      discovered: tests.length,
      passed: results.filter(item => item.status === 'PASS').length,
      failed: results.filter(item => item.status === 'FAIL').length,
      status: tests.length === 0 ? 'NO_TESTS_DISCOVERED'
        : results.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
    },
  };

  const path = regressionReportPath(artifactRoot, task.id);
  mkdirSync(join(artifactRoot, 'regression'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return report;
}
