import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeBuildId } from '../src/runtime/build-id.js';
import { classifyDaemonState, daemonLiveness, daemonPaths, daemonRequest, ensureAriadDaemon } from '../src/runtime/daemon.js';
import { runAriadRuntimeCli } from '../src/runtime/cli.js';

function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-buildid-'));
  fs.mkdirSync(path.join(root, 'src', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'a.js'), 'export const a = 1;\n');
  return root;
}

test('computeBuildId is deterministic and tracks source changes', () => {
  const root = tempTree();
  try {
    const first = computeBuildId(root);
    assert.equal(computeBuildId(root), first);
    fs.writeFileSync(path.join(root, 'src', 'notes.txt'), 'not code');
    assert.equal(computeBuildId(root), first, 'non-js files do not affect the build id');
    fs.writeFileSync(path.join(root, 'src', 'runtime', 'a.js'), 'export const a = 2;\n');
    assert.notEqual(computeBuildId(root), first, 'a source change changes the build id');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('classifyDaemonState implements the watchdog matrix', () => {
  const base = { localBuildId: 'B', hungAfterMs: 30000 };
  assert.equal(classifyDaemonState({ ...base, ping: { buildId: 'B' }, pidAlive: true, heartbeatAgeMs: 0 }), 'use');
  assert.equal(classifyDaemonState({ ...base, ping: { buildId: 'A' }, pidAlive: true, heartbeatAgeMs: 0 }), 'stale');
  assert.equal(classifyDaemonState({ ...base, ping: { buildId: undefined }, pidAlive: true, heartbeatAgeMs: 0 }), 'stale', 'a pre-handshake daemon is stale');
  assert.equal(classifyDaemonState({ ...base, ping: null, pidAlive: false, heartbeatAgeMs: null }), 'spawn');
  assert.equal(classifyDaemonState({ ...base, ping: null, pidAlive: true, heartbeatAgeMs: 1000 }), 'busy');
  assert.equal(classifyDaemonState({ ...base, ping: null, pidAlive: true, heartbeatAgeMs: 60000 }), 'hung');
  assert.equal(classifyDaemonState({ ...base, ping: null, pidAlive: true, heartbeatAgeMs: null }), 'hung');
});

test('daemonLiveness reads pid and heartbeat files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-liveness-'));
  try {
    const paths = daemonPaths(root);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.pid, process.pid + '\n');
    fs.writeFileSync(paths.heartbeat, JSON.stringify({ pid: process.pid, buildId: 'B', at: new Date(Date.now() - 2000).toISOString() }) + '\n');
    const live = daemonLiveness(root);
    assert.equal(live.pid, process.pid);
    assert.equal(live.pidAlive, true);
    assert.ok(live.heartbeatAgeMs >= 2000 && live.heartbeatAgeMs < 5000, `age ${live.heartbeatAgeMs}`);
    const empty = daemonLiveness(path.join(root, 'nope'));
    assert.equal(empty.pid, null);
    assert.equal(empty.pidAlive, false);
    assert.equal(empty.heartbeatAgeMs, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('daemon handshake: matching build is reused, stale build restarts when idle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-handshake-'));
  const stop = async () => {
    try { await daemonRequest(root, { action: 'daemon_shutdown' }); } catch {}
    await new Promise(done => setTimeout(done, 300));
  };
  try {
    await ensureAriadDaemon(root);
    const first = await daemonRequest(root, { action: 'ping' });
    assert.ok(first.buildId, 'ping reports a build id');
    assert.ok(first.startedAt, 'ping reports startedAt');
    const heartbeat = JSON.parse(fs.readFileSync(daemonPaths(root).heartbeat, 'utf8'));
    assert.equal(heartbeat.buildId, first.buildId, 'heartbeat carries the build id');

    await ensureAriadDaemon(root);
    const again = await daemonRequest(root, { action: 'ping' });
    assert.equal(again.pid, first.pid, 'matching build reuses the daemon');

    process.env.ARIAD_BUILD_ID = 'test-stale-build';
    try {
      await ensureAriadDaemon(root);
    } finally { delete process.env.ARIAD_BUILD_ID; }
    const restarted = await daemonRequest(root, { action: 'ping' });
    assert.notEqual(restarted.pid, first.pid, 'stale build forced a restart');
    assert.equal(restarted.buildId, 'test-stale-build', 'the fresh daemon runs the current build');
  } finally {
    delete process.env.ARIAD_BUILD_ID;
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watchdog: a frozen daemon with a stale heartbeat is killed and replaced', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-watchdog-'));
  try {
    await ensureAriadDaemon(root);
    const first = await daemonRequest(root, { action: 'ping' });
    process.kill(first.pid, 'SIGSTOP');
    try {
      // Heartbeat interval is 5s; with a 50ms staleness budget the frozen
      // daemon classifies as hung once its last beat is 50ms old.
      await new Promise(done => setTimeout(done, 200));
      await ensureAriadDaemon(root, { hungAfterMs: 50 });
    } finally {
      try { process.kill(first.pid, 'SIGKILL'); } catch {}
    }
    const second = await daemonRequest(root, { action: 'ping' });
    assert.notEqual(second.pid, first.pid, 'hung daemon was replaced');
    assert.throws(() => process.kill(first.pid, 0), 'old pid is gone');
  } finally {
    try { await daemonRequest(root, { action: 'daemon_shutdown' }); } catch {}
    await new Promise(done => setTimeout(done, 300));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI daemon status exposes the stale flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-status-'));
  const args = (...parts) => [...parts, '--projects-root', root];
  try {
    await runAriadRuntimeCli(args('daemon', 'start'));
    const fresh = await runAriadRuntimeCli(args('daemon', 'status'));
    assert.equal(fresh.running, true);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.buildId, fresh.localBuildId);
    process.env.ARIAD_BUILD_ID = 'some-other-build';
    try {
      const stale = await runAriadRuntimeCli(args('daemon', 'status'));
      assert.equal(stale.stale, true);
    } finally { delete process.env.ARIAD_BUILD_ID; }
  } finally {
    delete process.env.ARIAD_BUILD_ID;
    try { await runAriadRuntimeCli(args('daemon', 'stop')); } catch {}
    await new Promise(done => setTimeout(done, 300));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
