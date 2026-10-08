import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

function uniq(items) { return [...new Set(items)]; }

const TRACKED_EXTENSIONS = new Set(['.gd', '.json', '.tscn', '.tres', '.cfg', '.gdshader', '.shader']);

function normalizeRel(path) {
  return String(path ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function gitLines(workspace, args) {
  try {
    return execFileSync('git', args, {
      cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).map(normalizeRel).filter(Boolean);
  } catch {
    return [];
  }
}

function changedArtifacts(workspace) {
  const inRepo = gitLines(workspace, ['rev-parse', '--is-inside-work-tree']).includes('true');
  if (!inRepo) return [];
  const hasHead = gitLines(workspace, ['rev-parse', '--verify', 'HEAD']).length > 0;
  const tracked = hasHead
    ? gitLines(workspace, ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'])
    : gitLines(workspace, ['ls-files', '--cached']);
  const untracked = gitLines(workspace, ['ls-files', '--others', '--exclude-standard']);
  return uniq([...tracked, ...untracked]).filter(rel => {
    if (rel.startsWith('.ariad/') || rel.startsWith('.godot/')) return false;
    if (rel.includes('/__tests__/') || rel.startsWith('__tests__/')) return false;
    if (rel.startsWith('tests/')) return false;
    return TRACKED_EXTENSIONS.has(extname(rel).toLowerCase());
  });
}

function candidateTestsForArtifact(rel) {
  const dir = dirname(rel);
  const artifactBase = basename(rel, extname(rel));
  const local = normalizeRel(join(dir, '__tests__', artifactBase + '__test.gd'));
  const parent = dirname(dir);
  const folder = basename(dir);
  const parentLevel = dir === '.' || !folder
    ? null
    : normalizeRel(join(parent, '__tests__', folder + '__test.gd'));
  return [local, parentLevel].filter(Boolean);
}

export function discoverCiTests({ workspace, changedFiles = null }) {
  const artifacts = changedFiles ?? changedArtifacts(workspace);
  const tests = [];
  const coverageGaps = [];
  const byArtifact = [];
  for (const rel of artifacts) {
    const candidates = candidateTestsForArtifact(rel);
    const existing = candidates.filter(test => existsSync(resolve(workspace, test)));
    tests.push(...existing);
    if (existing.length === 0) coverageGaps.push(rel);
    byArtifact.push({ artifact: rel, candidates, selected: existing });
  }
  return { artifacts, tests: uniq(tests), coverageGaps, byArtifact };
}

// Compatibility export for callers/tests written before locality CI replaced artifact discovery.
export function discoverFocusedTests({ workspace }) {
  return discoverCiTests({ workspace }).tests;
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

export function runAutomatedRegression({ workspace, artifactRoot, task, timeoutMs = 300000 }) {
  if (!workspace || !artifactRoot || !task?.id) return null;
  const discovery = discoverCiTests({ workspace });
  const results = [];
  for (const rel of discovery.tests) {
    const started = Date.now();
    let ok = false;
    let output = '';
    let failure = null;
    const isolatedDataHome = mkdtempSync(join(tmpdir(), 'ariad-ci-userdata-'));
    try {
      output = execFileSync('godot', [
        '--headless', '--audio-driver', 'Dummy', '--path', workspace,
        '-s', `res://${rel}`,
      ], {
        cwd: workspace,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        env: { ...process.env, XDG_DATA_HOME: isolatedDataHome },
      });
      ok = true;
    } catch (error) {
      output = `${error?.stdout?.toString?.() ?? ''}\n${error?.stderr?.toString?.() ?? ''}`;
      failure = error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (error?.message ?? String(error));
    } finally {
      rmSync(isolatedDataHome, { recursive: true, force: true });
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
    schema: 'ariad-automated-regression-v2',
    taskId: task.id,
    generatedAt: new Date().toISOString(),
    source: 'two-level-locality-ci',
    changedArtifacts: discovery.artifacts,
    selection: discovery.byArtifact,
    coverageGaps: discovery.coverageGaps,
    verificationTargets: structuredClone(task.verification ?? task.input?.verification ?? []),
    tests: results,
    summary: {
      discovered: discovery.tests.length,
      passed: results.filter(item => item.status === 'PASS').length,
      failed: results.filter(item => item.status === 'FAIL').length,
      coverageGaps: discovery.coverageGaps.length,
      status: results.some(item => item.status === 'FAIL') ? 'FAIL'
        : discovery.tests.length === 0 ? 'NO_LOCAL_CI_TESTS'
          : 'PASS',
    },
  };

  const path = regressionReportPath(artifactRoot, task.id);
  mkdirSync(join(artifactRoot, 'regression'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return report;
}
