// Managed bash for Ariad role sessions (2026-11-03, project-owner design).
//
// Pi's built-in bash blocks the session until the command exits and has no
// default timeout: a command that never returns (a repro script waiting on
// a hung engine, a dev server, a prompt) hangs the whole role session
// silently — on 2026-11-03 a tester session sat inside one call for 58
// minutes while every outer watchdog saw a healthy daemon. The fix puts
// the watch at the point of execution and the judgement with the model:
// commands run supervised in the background; if a command is still running
// after a configurable check interval, the tool call returns a
// STILL_RUNNING receipt (elapsed time, output tail, log path) and the
// MODEL decides — bash_wait to keep waiting, bash_kill to terminate it.
// A command started with an explicit timeout runs in direct mode with a
// hard deadline, like the built-in tool.
//
// Every supervised process is spawned detached (its own process group)
// with an ARIAD_MANAGED_BASH=<registryId> environment birthmark. A
// registry dies with its session: disposing the session kills everything
// it left running. The sweeper below reaps marked processes whose
// registry is gone (daemon hard-killed, dispose never ran), plus — on
// daemon startup only — the legacy e2e orphans that predate the marker.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';

export const MANAGED_BASH_MARKER = 'ARIAD_MANAGED_BASH';
export const DEFAULT_CHECK_INTERVAL_MS = 600_000; // 10 minutes

const OUTPUT_TAIL_CHARS = 128 * 1024;
const RECEIPT_TAIL_CHARS = 4_000;
const KILL_ESCALATION_MS = 2_000;

const liveRegistryIds = new Set();
let lastSweepAtMs = 0;

export function managedBashCheckIntervalMs(env = process.env) {
  const parsed = Number.parseInt(env.ARIAD_BASH_CHECK_INTERVAL_MS ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 3_600_000) return parsed;
  return DEFAULT_CHECK_INTERVAL_MS;
}

export function killProcessGroup(pgid, signal) {
  if (!pgid) return false;
  try { process.kill(-pgid, signal); return true; } catch { /* group gone */ }
  try { process.kill(pgid, signal); return true; } catch { return false; }
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function createManagedBashRegistry({ workspace, checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS } = {}) {
  const registry = {
    id: randomUUID(),
    workspace,
    checkIntervalMs,
    records: new Map(),
    sequence: 0,
    disposed: false,
    logDir: join(workspace, '.ariad', 'managed-bash'),
  };
  liveRegistryIds.add(registry.id);

  function settle(record) {
    try { record.logStream?.end(); } catch { /* stream already closed */ }
    for (const waiter of [...record.waiters]) waiter();
    record.waiters.clear();
  }

  registry.start = (command) => {
    const handle = `mb-${++registry.sequence}-${registry.id.slice(0, 8)}`;
    let logStream = null;
    let logPath = null;
    try {
      mkdirSync(registry.logDir, { recursive: true });
      logPath = join(registry.logDir, `${handle}.log`);
      logStream = createWriteStream(logPath, { flags: 'a' });
      logStream.on('error', () => {});
    } catch { logStream = null; logPath = null; }
    const child = spawn(command, {
      shell: '/bin/bash',
      cwd: workspace,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [MANAGED_BASH_MARKER]: registry.id },
    });
    const record = {
      handle, command, pid: child.pid ?? null, child,
      startedAt: Date.now(), tail: '', totalBytes: 0,
      exit: null, killReason: null, logPath, logStream, waiters: new Set(),
    };
    const onData = (chunk) => {
      record.totalBytes += chunk.length;
      try { logStream?.write(chunk); } catch { /* best effort */ }
      let tail = record.tail + chunk.toString('utf8');
      if (tail.length > OUTPUT_TAIL_CHARS) tail = tail.slice(tail.length - OUTPUT_TAIL_CHARS);
      record.tail = tail;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      if (!record.exit) { record.exit = { code: null, signal: null, error: String(error?.message ?? error) }; settle(record); }
    });
    child.on('exit', (code, signal) => {
      if (!record.exit) { record.exit = { code, signal }; settle(record); }
    });
    try { child.unref(); child.stdout?.unref(); child.stderr?.unref(); } catch { /* noop */ }
    registry.records.set(handle, record);
    return record;
  };

  registry.terminate = (record, reason) => {
    if (!record || record.exit) return;
    record.killReason = record.killReason ?? reason;
    killProcessGroup(record.pid, 'SIGTERM');
    const escalate = setTimeout(() => { if (!record.exit) killProcessGroup(record.pid, 'SIGKILL'); }, KILL_ESCALATION_MS);
    escalate.unref?.();
  };

  registry.dispose = () => {
    if (registry.disposed) return;
    registry.disposed = true;
    liveRegistryIds.delete(registry.id);
    for (const record of registry.records.values()) registry.terminate(record, 'session-ended');
  };

  return registry;
}

export function waitForExitOrInterval(record, ms, signal) {
  if (record.exit) return Promise.resolve('exited');
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      record.waiters.delete(onExit);
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
      resolve(value);
    };
    const onExit = () => finish('exited');
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('interval'), ms);
    timer.unref?.();
    record.waiters.add(onExit);
    if (signal) {
      if (signal.aborted) { finish('aborted'); return; }
      try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* noop */ }
    }
  });
}

function outputText(record) {
  const body = record.tail.length > 0 ? record.tail : '(no output)';
  if (record.totalBytes > record.tail.length && record.logPath) {
    return `${body}\n\n[output truncated: showing the last ${record.tail.length} of ${record.totalBytes} bytes; full output in ${record.logPath}]`;
  }
  return body;
}

function completionResult(record) {
  let text = outputText(record);
  const { code, signal, error } = record.exit ?? {};
  let failed = false;
  if (record.killReason === 'timeout') {
    text += `\n\nCommand timed out and was killed.`;
    failed = true;
  } else if (typeof code === 'number' && code !== 0) {
    text += `\n\nCommand exited with code ${code}`;
    failed = true;
  } else if (signal) {
    text += `\n\nCommand terminated by signal ${signal}`;
    failed = true;
  } else if (error) {
    text += `\n\nCommand failed to run: ${error}`;
    failed = true;
  }
  return {
    content: [{ type: 'text', text }],
    ...(failed ? { isError: true } : {}),
    details: {
      managed: true, handle: record.handle,
      exitCode: typeof code === 'number' ? code : null,
      signal: signal ?? null,
      elapsedMs: Date.now() - record.startedAt,
      totalBytes: record.totalBytes,
    },
  };
}

function stillRunningResult(registry, record) {
  const elapsedMs = Date.now() - record.startedAt;
  const tail = record.tail.slice(-RECEIPT_TAIL_CHARS);
  const text = [
    `STILL_RUNNING: this command has been running for ${formatElapsed(elapsedMs)} and has not finished. It has NOT been killed — it keeps running under supervision.`,
    `handle: ${record.handle}`,
    `pid: ${record.pid}`,
    `command: ${record.command.slice(0, 300)}`,
    `output so far: ${record.totalBytes} bytes${record.logPath ? `; full log at ${record.logPath}` : ''}`,
    tail ? `--- latest output ---\n${tail}` : '(no output yet)',
    'Decide now: if the command looks healthy, call bash_wait with this handle to keep waiting (returns when the command finishes or after another check interval; pass timeout in seconds to wait longer). If it looks stuck, call bash_kill with this handle to terminate it and move on. Do NOT re-issue the same command while its handle is still running.',
  ].join('\n');
  return {
    content: [{ type: 'text', text }],
    details: { managed: true, handle: record.handle, status: 'running', elapsedMs, pid: record.pid },
  };
}

function unknownHandleResult(registry, handle) {
  const live = [...registry.records.values()].filter((r) => !r.exit).map((r) => r.handle);
  return {
    content: [{ type: 'text', text: `Unknown bash handle: ${handle}. It may have already finished and been collected.${live.length ? ` Handles still running in this session: ${live.join(', ')}.` : ' No managed commands are running in this session.'}` }],
    isError: true,
    details: { managed: true, handle, status: 'unknown' },
  };
}

const BASH_DESCRIPTION = [
  'Run a shell command in the workspace with supervision.',
  'A command that finishes within the check interval (10 minutes by default) returns its output and exit code directly.',
  'A command still running at the check interval is NOT killed: this call returns a STILL_RUNNING receipt with a handle, elapsed time and the latest output, and you decide — call bash_wait to keep waiting on it, or bash_kill to terminate it. Never re-issue the same command while a handle for it is running.',
  'Pass timeout (seconds) only when a command has a real deadline: it then runs in direct mode and is killed when the deadline passes.',
  'Commands run non-interactively with stdin closed; do not start servers or anything that waits for input.',
].join(' ');

export function registerManagedBashTools(pi, { workspace, checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS } = {}) {
  const registry = createManagedBashRegistry({ workspace, checkIntervalMs });

  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description: BASH_DESCRIPTION,
    promptGuidelines: [
      'Long-running commands are supervised: when bash returns STILL_RUNNING, judge the output and then call bash_wait or bash_kill for that handle instead of re-running the command.',
    ],
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to run.' }),
      timeout: Type.Optional(Type.Number({ description: 'Optional hard timeout in seconds (direct mode): the command is killed when it passes.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const command = String(params?.command ?? '');
      if (!command.trim()) throw new Error('bash requires a non-empty command');
      const record = registry.start(command);
      const explicitTimeoutMs = params?.timeout != null ? Math.max(1, Number(params.timeout)) * 1000 : null;
      const outcome = await waitForExitOrInterval(record, explicitTimeoutMs ?? registry.checkIntervalMs, signal);
      if (outcome === 'aborted') {
        registry.terminate(record, 'aborted');
        return { content: [{ type: 'text', text: 'bash call aborted; the command was terminated.' }], isError: true, details: { managed: true, handle: record.handle, status: 'aborted' } };
      }
      if (outcome === 'exited') return completionResult(record);
      if (explicitTimeoutMs != null) {
        registry.terminate(record, 'timeout');
        await waitForExitOrInterval(record, 3_000);
        const result = completionResult(record);
        result.content = [{ type: 'text', text: `${outputText(record)}\n\nCommand timed out after ${formatElapsed(explicitTimeoutMs)} and was killed.` }];
        return result;
      }
      return stillRunningResult(registry, record);
    },
  });

  pi.registerTool({
    name: 'bash_wait',
    label: 'bash wait',
    description: 'Keep waiting on a supervised bash command started earlier (see the handle in its STILL_RUNNING receipt). Returns the command result when it finishes, or another STILL_RUNNING receipt after one more check interval. Pass timeout (seconds) to wait for a different span.',
    parameters: Type.Object({
      handle: Type.String({ description: 'The handle from a STILL_RUNNING receipt.' }),
      timeout: Type.Optional(Type.Number({ description: 'Seconds to wait this time (default: the check interval).' })),
    }),
    async execute(_toolCallId, params, signal) {
      const record = registry.records.get(String(params?.handle ?? ''));
      if (!record) return unknownHandleResult(registry, String(params?.handle ?? ''));
      if (record.exit) return completionResult(record);
      const waitMs = params?.timeout != null ? Math.max(1, Number(params.timeout)) * 1000 : registry.checkIntervalMs;
      const outcome = await waitForExitOrInterval(record, waitMs, signal);
      if (outcome === 'exited') return completionResult(record);
      if (outcome === 'aborted') return stillRunningResult(registry, record);
      return stillRunningResult(registry, record);
    },
  });

  pi.registerTool({
    name: 'bash_kill',
    label: 'bash kill',
    description: 'Terminate a supervised bash command (see the handle in its STILL_RUNNING receipt) and return its output so far. Use this when the command looks stuck; the work it already did on disk stays.',
    parameters: Type.Object({
      handle: Type.String({ description: 'The handle from a STILL_RUNNING receipt.' }),
    }),
    async execute(_toolCallId, params) {
      const record = registry.records.get(String(params?.handle ?? ''));
      if (!record) return unknownHandleResult(registry, String(params?.handle ?? ''));
      if (record.exit) return completionResult(record);
      registry.terminate(record, 'model');
      await waitForExitOrInterval(record, 3_000);
      const elapsedMs = Date.now() - record.startedAt;
      const tail = record.tail.slice(-RECEIPT_TAIL_CHARS);
      return {
        content: [{ type: 'text', text: `Killed managed command ${record.handle} after ${formatElapsed(elapsedMs)}.${record.exit ? '' : ' (process group signalled; exit not yet observed)'} Latest output:\n${tail || '(no output)'}` }],
        details: { managed: true, handle: record.handle, status: 'killed', elapsedMs },
      };
    },
  });

  return registry;
}

// --- Orphan sweeper -------------------------------------------------------
// Reaps processes that carry the managed-bash birthmark but whose registry
// is no longer live in this process (their session ended without dispose,
// or the daemon that spawned them died). Optionally also reaps the legacy
// e2e orphans (ARIAD_ZERO_E2E_ROOT) that predate the marker system; those
// are disposable test spawns by construction. Only process groups created
// by our own detached spawns are group-killed; legacy orphans are killed
// individually so nothing that merely shares their group is touched.

function readProcStat(procRoot, pid) {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pgid: Number(afterComm[2]) || pid };
  } catch { return null; }
}

export function sweepManagedBashOrphans({
  graceMs = 120_000,
  includeLegacyE2e = false,
  legacyE2eMinAgeMs = 24 * 3_600_000,
  nowMs = Date.now(),
  procRoot = '/proc',
  throttleMs = 60_000,
} = {}) {
  if (throttleMs > 0 && nowMs - lastSweepAtMs < throttleMs) return [];
  lastSweepAtMs = nowMs;
  let entries;
  try { entries = readdirSync(procRoot); } catch { return []; }
  const managedGroups = new Map(); // pgid -> { pid, startedAtMs }
  const legacyPids = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid || pid === process.ppid) continue;
    let environText;
    try { environText = readFileSync(join(procRoot, name, 'environ'), 'utf8'); } catch { continue; }
    const vars = environText.split('\0').filter(Boolean);
    const marker = vars.find((v) => v.startsWith(`${MANAGED_BASH_MARKER}=`));
    let startedAtMs = null;
    try { startedAtMs = statSync(join(procRoot, name)).mtimeMs; } catch { continue; }
    if (marker) {
      const registryId = marker.slice(MANAGED_BASH_MARKER.length + 1);
      if (liveRegistryIds.has(registryId)) continue;
      const stat = readProcStat(procRoot, pid);
      const pgid = stat?.pgid ?? pid;
      const existing = managedGroups.get(pgid);
      if (!existing || startedAtMs < existing.startedAtMs) managedGroups.set(pgid, { pid, startedAtMs });
    } else if (includeLegacyE2e && vars.some((v) => v.startsWith('ARIAD_ZERO_E2E_ROOT='))) {
      if (nowMs - startedAtMs >= legacyE2eMinAgeMs) legacyPids.push(pid);
    }
  }
  const reaped = [];
  for (const [pgid, { pid, startedAtMs }] of managedGroups) {
    if (nowMs - startedAtMs < graceMs) continue;
    if (killProcessGroup(pgid, 'SIGTERM')) reaped.push({ pid, pgid, reason: 'managed-orphan' });
  }
  for (const pid of legacyPids) {
    try { process.kill(pid, 'SIGTERM'); reaped.push({ pid, pgid: null, reason: 'legacy-e2e-orphan' }); } catch { /* already gone */ }
  }
  if (reaped.length > 0) {
    const groups = reaped.filter((r) => r.pgid != null).map((r) => r.pgid);
    const individuals = reaped.filter((r) => r.pgid == null).map((r) => r.pid);
    const escalate = setTimeout(() => {
      for (const pgid of groups) { try { process.kill(-pgid, 0); killProcessGroup(pgid, 'SIGKILL'); } catch { /* gone */ } }
      for (const pid of individuals) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }, KILL_ESCALATION_MS);
    escalate.unref?.();
  }
  return reaped;
}
