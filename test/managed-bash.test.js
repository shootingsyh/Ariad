import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MANAGED_BASH_MARKER,
  createManagedBashRegistry,
  registerManagedBashTools,
  sweepManagedBashOrphans,
  waitForExitOrInterval,
} from '../src/runtime/managed-bash.js';

function fakePi() {
  const tools = new Map();
  return { tools, registerTool(definition) { tools.set(definition.name, definition); } };
}

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'ariad-managed-bash-'));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await delay(50);
  }
  return false;
}

test('managed bash: fast command returns output and exit status directly', async () => {
  const pi = fakePi();
  const registry = registerManagedBashTools(pi, { workspace: tempWorkspace(), checkIntervalMs: 2_000 });
  try {
    const bash = pi.tools.get('bash');
    assert.ok(bash, 'bash tool registered');
    assert.ok(pi.tools.get('bash_wait'), 'bash_wait registered');
    assert.ok(pi.tools.get('bash_kill'), 'bash_kill registered');
    const ok = await bash.execute('t1', { command: 'echo hello-managed' });
    assert.match(ok.content[0].text, /hello-managed/);
    assert.notEqual(ok.isError, true);
    const bad = await bash.execute('t2', { command: 'exit 3' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /exited with code 3/);
  } finally { registry.dispose(); }
});

test('managed bash: long command returns STILL_RUNNING, bash_wait collects the result', async () => {
  const pi = fakePi();
  const registry = registerManagedBashTools(pi, { workspace: tempWorkspace(), checkIntervalMs: 200 });
  try {
    const first = await pi.tools.get('bash').execute('t1', { command: 'sleep 1; echo finished-late' });
    assert.match(first.content[0].text, /STILL_RUNNING/);
    const handle = first.details.handle;
    assert.ok(handle);
    const waited = await pi.tools.get('bash_wait').execute('t2', { handle, timeout: 5 });
    assert.match(waited.content[0].text, /finished-late/);
    assert.notEqual(waited.isError, true);
    assert.equal(waited.details.exitCode, 0);
  } finally { registry.dispose(); }
});

test('managed bash: bash_kill terminates a stuck command and returns its output', async () => {
  const pi = fakePi();
  const registry = registerManagedBashTools(pi, { workspace: tempWorkspace(), checkIntervalMs: 200 });
  try {
    const first = await pi.tools.get('bash').execute('t1', { command: 'echo before-hang; sleep 60' });
    assert.match(first.content[0].text, /STILL_RUNNING/);
    const { handle, pid } = first.details;
    const killed = await pi.tools.get('bash_kill').execute('t2', { handle });
    assert.match(killed.content[0].text, /Killed managed command/);
    assert.match(killed.content[0].text, /before-hang/);
    assert.equal(await waitUntilDead(pid), true, 'process is actually gone');
  } finally { registry.dispose(); }
});

test('managed bash: explicit timeout runs in direct mode with a hard deadline', async () => {
  const pi = fakePi();
  const registry = registerManagedBashTools(pi, { workspace: tempWorkspace(), checkIntervalMs: 60_000 });
  try {
    const started = Date.now();
    const result = await pi.tools.get('bash').execute('t1', { command: 'sleep 30', timeout: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out after/);
    assert.ok(Date.now() - started < 10_000, 'returned shortly after the deadline');
  } finally { registry.dispose(); }
});

test('managed bash: processes carry the birthmark and dispose kills what is left', async () => {
  const workspace = tempWorkspace();
  const registry = createManagedBashRegistry({ workspace, checkIntervalMs: 200 });
  const record = registry.start('sleep 60');
  assert.ok(record.pid);
  if (existsSync('/proc')) {
    const environ = readFileSync(join('/proc', String(record.pid), 'environ'), 'utf8');
    assert.ok(environ.includes(`${MANAGED_BASH_MARKER}=${registry.id}`), 'birthmark present in child env');
  }
  registry.dispose();
  assert.equal(await waitForExitOrInterval(record, 5_000), 'exited');
  assert.equal(await waitUntilDead(record.pid), true);
});

test('managed bash sweeper: reaps orphans of dead registries, spares live ones', async () => {
  const workspace = tempWorkspace();
  const live = createManagedBashRegistry({ workspace, checkIntervalMs: 200 });
  const liveRecord = live.start('sleep 60');
  const orphan = spawn('sleep 60', {
    shell: '/bin/bash', detached: true, stdio: 'ignore',
    env: { ...process.env, [MANAGED_BASH_MARKER]: randomUUID() },
  });
  orphan.unref();
  try {
    await delay(100);
    const reaped = sweepManagedBashOrphans({ graceMs: 0, throttleMs: 0 });
    assert.ok(reaped.some((r) => r.reason === 'managed-orphan'), 'orphan reaped');
    assert.equal(await waitUntilDead(orphan.pid), true, 'orphan process gone');
    try { process.kill(liveRecord.pid, 0); } catch { assert.fail('live registry process must not be reaped'); }
  } finally {
    live.dispose();
    await waitUntilDead(liveRecord.pid).catch(() => {});
    try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});
