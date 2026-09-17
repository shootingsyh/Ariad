import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AriadProjectManager, slugify } from '../extensions/openclaw-ariad/runtime/project-manager.js';

test('OpenClaw Ariad project manager isolates project folders and daemon state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-openclaw-'));
  const alive = new Set();
  const spawnCalls = [];
  let nextPid = 4100;
  const manager = new AriadProjectManager({
    projectsRoot: join(dir, 'projects'),
    daemonEntry: join(dir, 'daemon-worker.js'),
    isProcessAlive: (pid) => alive.has(pid),
    kill: (pid) => alive.delete(pid),
    spawn: (command, args, options) => {
      const pid = nextPid++;
      alive.add(pid);
      spawnCalls.push({ pid, command, args, options });
      return { pid, unref() {} };
    },
    now: () => new Date('2026-09-16T12:00:00.000Z'),
  });

  try {
    const alpha = manager.create('Alpha Project', { goal: 'build alpha' });
    const beta = manager.create('Beta Project', { goal: 'build beta' });

    assert.equal(alpha.id, 'alpha-project');
    assert.equal(beta.id, 'beta-project');
    assert.notEqual(alpha.root, beta.root);
    assert.notEqual(alpha.workspace, beta.workspace);
    assert.notEqual(alpha.stateDb, beta.stateDb);
    assert.ok(existsSync(join(alpha.root, 'workspace')));
    assert.ok(existsSync(join(beta.root, 'workspace')));

    const alphaStarted = manager.start('alpha-project');
    const betaStarted = manager.start('beta-project');
    assert.equal(alphaStarted.running, true);
    assert.equal(betaStarted.running, true);
    assert.notEqual(alphaStarted.pid, betaStarted.pid);
    assert.equal(spawnCalls.length, 2);
    assert.notEqual(spawnCalls[0].options.cwd, spawnCalls[1].options.cwd);
    assert.notEqual(spawnCalls[0].options.env.ARIAD_STATE_DB, spawnCalls[1].options.env.ARIAD_STATE_DB);
    assert.notEqual(spawnCalls[0].options.env.ARIAD_PROJECT_ROOT, spawnCalls[1].options.env.ARIAD_PROJECT_ROOT);

    assert.equal(manager.status('alpha-project').running, true);
    assert.equal(manager.status('beta-project').running, true);
    manager.stop('alpha-project');
    assert.equal(manager.status('alpha-project').running, false);
    assert.equal(manager.status('beta-project').running, true, 'stopping one project must not affect another');

    const listed = manager.list();
    assert.deepEqual(listed.map((p) => p.id).sort(), ['alpha-project', 'beta-project']);
    assert.match(readFileSync(join(beta.root, 'project.json'), 'utf8'), /build beta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project ids cannot escape the configured projects root', () => {
  assert.equal(slugify('../My Project'), '..-my-project');
  assert.throws(() => slugify('..'), /letters or numbers/);
  assert.throws(() => slugify('---'), /letters or numbers/);
});

test('OpenClaw plugin manifest owns exactly one Ariad tool', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/openclaw-ariad/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'ariad');
  assert.deepEqual(manifest.contracts.tools, ['ariad_project']);
  assert.equal(manifest.activation.onStartup, true);
});
