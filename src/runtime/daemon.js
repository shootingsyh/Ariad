#!/usr/bin/env node
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, unlinkSync, chmodSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { ariadBuildId } from './build-id.js';
import { AriadProjectManager, defaultProjectsRoot } from './project-manager.js';
import { AriadService } from './ariad-service.js';
import { PiAgentSessionProvider } from './pi-agent-session-provider.js';
import { createAriadControlTools } from './control-tools.js';
import { AriadDashboardService } from './dashboard-service.js';

export function daemonPaths(root) {
  const dir = join(root, '.runtime');
  return { dir, socket: join(dir, 'ariad.sock'), pid: join(dir, 'ariad.pid'), log: join(dir, 'ariad.log'), config: join(dir, 'config.json'), heartbeat: join(dir, 'heartbeat.json') };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** File-based liveness: what the pid file and heartbeat say, without the socket. */
export function daemonLiveness(root, { now = Date.now() } = {}) {
  const paths = daemonPaths(root);
  let pid = null;
  try { pid = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10) || null; } catch {}
  let heartbeat = null;
  try { heartbeat = JSON.parse(readFileSync(paths.heartbeat, 'utf8')); } catch {}
  const heartbeatAt = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  return {
    pid,
    pidAlive: pidAlive(pid),
    heartbeat,
    heartbeatAgeMs: Number.isFinite(heartbeatAt) ? Math.max(0, now - heartbeatAt) : null,
  };
}

/**
 * The watchdog decision matrix for a daemon that did not answer a ping:
 * no live pid -> spawn; live pid with a fresh heartbeat -> busy (wait,
 * never kill a heartbeating daemon); live pid with a stale or missing
 * heartbeat -> hung (kill and respawn; a second live daemon must never
 * share one projects root).
 */
export function classifyDaemonState({ ping, pidAlive: alive, heartbeatAgeMs, localBuildId, hungAfterMs = 30000 }) {
  if (ping) return ping.buildId === localBuildId ? 'use' : 'stale';
  if (!alive) return 'spawn';
  if (heartbeatAgeMs != null && heartbeatAgeMs <= hungAfterMs) return 'busy';
  return 'hung';
}

async function terminatePid(pid) {
  if (!pidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (!pidAlive(pid)) return; await sleep(100); }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) { if (!pidAlive(pid)) return; await sleep(100); }
}

export function daemonRequest(root, input, { timeoutMs = 20000 } = {}) {
  const { socket } = daemonPaths(root);
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let data = '';
    const timeout = setTimeout(() => conn.destroy(new Error('ARIAD_DAEMON_TIMEOUT')), timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify(input) + '\n'));
    conn.on('data', chunk => {
      data += chunk.toString();
      const end = data.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timeout);
      conn.end();
      try {
        const reply = JSON.parse(data.slice(0, end));
        if (!reply.ok) reject(new Error(reply.error ?? 'daemon request failed'));
        else resolve(reply.value);
      } catch (error) { reject(error); }
    });
    conn.on('error', error => { clearTimeout(timeout); reject(error); });
    conn.on('close', () => { clearTimeout(timeout); });
  });
}

export async function ensureAriadDaemon(root, { timeoutMs = 8000, buildId = ariadBuildId(), hungAfterMs = 30000 } = {}) {
  const paths = daemonPaths(root);
  const attemptPing = async ms => {
    try { return await daemonRequest(root, { action: 'ping' }, { timeoutMs: ms }); } catch { return null; }
  };
  let ping = await attemptPing(1500);
  if (!ping) {
    const liveness = daemonLiveness(root);
    const state = classifyDaemonState({ ping: null, pidAlive: liveness.pidAlive, heartbeatAgeMs: liveness.heartbeatAgeMs, localBuildId: buildId, hungAfterMs });
    if (state === 'busy') {
      // Heartbeat fresh but socket silent: startup or a long control
      // call. Give it a bounded chance; never kill a heartbeating daemon.
      const deadline = Date.now() + 4000;
      while (!ping && Date.now() < deadline) { await sleep(200); ping = await attemptPing(500); }
      if (!ping) throw new Error('ARIAD_DAEMON_UNRESPONSIVE: daemon is alive and heartbeating but not answering; inspect ' + paths.log);
    } else if (state === 'hung') {
      // Watchdog: alive but not heartbeating and not answering — it will
      // not recover on its own. Kill it before spawning a replacement.
      console.error(`ARIAD_DAEMON_HUNG: pid ${liveness.pid} is alive with a stale heartbeat; terminating it before restart`);
      await terminatePid(liveness.pid);
      try { unlinkSync(paths.socket); } catch {}
      try { unlinkSync(paths.pid); } catch {}
      try { unlinkSync(paths.heartbeat); } catch {}
    }
  }
  if (ping) {
    if (ping.buildId === buildId) return paths;
    // Version handshake: a daemon executing stale code must not serve
    // current commands. Restart it when idle — daemon_shutdown itself
    // refuses while projects are RUNNING, which becomes the error below.
    try {
      await daemonRequest(root, { action: 'daemon_shutdown' }, { timeoutMs: 5000 });
    } catch (error) {
      throw new Error(`ARIAD_DAEMON_STALE_BUILD: daemon pid ${ping.pid} runs build ${ping.buildId ?? 'unknown'} but the code on disk is build ${buildId}, and it cannot restart now (${error.message}). Stop its projects, run 'ariad daemon stop', then retry.`);
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (!(await attemptPing(400))) break; await sleep(150); }
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const fd = openSync(paths.log, 'a', 0o600);
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--serve', root], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const fresh = await daemonRequest(root, { action: 'ping' }, { timeoutMs: 500 });
      if (fresh.buildId !== buildId) throw new Error(`ARIAD_DAEMON_BUILD_MISMATCH_AFTER_START: fresh daemon reports build ${fresh.buildId ?? 'unknown'}, expected ${buildId}`);
      return paths;
    } catch (error) {
      if (error?.message?.startsWith('ARIAD_DAEMON_BUILD_MISMATCH_AFTER_START')) throw error;
    }
    if (child.exitCode != null) throw new Error('ARIAD_DAEMON_START_FAILED: inspect ' + paths.log);
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('ARIAD_DAEMON_START_TIMEOUT: inspect ' + paths.log);
}

export async function serveAriad(root) {
  const paths = daemonPaths(root);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  // If a live daemon already owns the socket, do not hijack it.
  if (existsSync(paths.socket)) {
    try {
      await daemonRequest(root, { action: 'ping' }, { timeoutMs: 1000 });
      throw new Error('ARIAD_DAEMON_ALREADY_RUNNING');
    } catch (error) {
      if (error.message === 'ARIAD_DAEMON_ALREADY_RUNNING') throw error;
      unlinkSync(paths.socket);
    }
  }
  if (!process.env.ARIAD_LLAMACPP_BASE_URL && existsSync(paths.config)) {
    const config = JSON.parse(readFileSync(paths.config, 'utf8'));
    if (typeof config.localModelBaseUrl === 'string') {
      process.env.ARIAD_LLAMACPP_BASE_URL = config.localModelBaseUrl;
    }
  }
  const buildId = ariadBuildId();
  const startedAt = new Date().toISOString();
  const manager = new AriadProjectManager({ projectsRoot: root });
  const provider = new PiAgentSessionProvider();
  const service = new AriadService({
    manager, provider,
    reconcileWakePath: join(paths.dir, 'reconcile.wake'),
    safetyIntervalMs: 10000,
    memoryCurator: { async tick() { return { state: 'DISABLED' }; }, async close() {} },
    logger: { warn: (...args) => console.error(...args), error: (...args) => console.error(...args) },
  });
  const control = createAriadControlTools({ manager, service });
  let dashboard = null;
  let dashboardSettings = null;
  function readConfig() {
    if (!existsSync(paths.config)) return {};
    return JSON.parse(readFileSync(paths.config, 'utf8'));
  }
  function writeConfig(config) {
    const temporary = paths.config + '.tmp';
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, paths.config);
  }
  function dashboardStatus() {
    return {
      running: dashboard != null,
      enabled: readConfig().dashboard?.enabled === true,
      address: dashboard?.address ?? null,
      url: dashboard?.url ?? null,
    };
  }
  async function startDashboard({ port = null } = {}) {
    if (dashboard) return dashboardStatus();
    const config = readConfig();
    const configured = config.dashboard ?? {};
    const selectedPort = port ?? configured.port ?? 18793;
    if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
      throw new Error('dashboard port must be 1..65535');
    }
    const instance = new AriadDashboardService({
      manager, host: '127.0.0.1', port: selectedPort,
      logger: { info: (...args) => console.log(...args) },
    });
    await instance.start();
    dashboard = instance;
    dashboardSettings = { enabled: true, port: selectedPort };
    writeConfig({ ...config, dashboard: dashboardSettings });
    return dashboardStatus();
  }
  async function stopDashboard() {
    const config = readConfig();
    if (dashboard) await dashboard.stop();
    dashboard = null;
    dashboardSettings = null;
    writeConfig({ ...config, dashboard: { ...(config.dashboard ?? {}), enabled: false } });
    return dashboardStatus();
  }
  const server = createServer(conn => {
    let data = '';
    conn.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) { conn.destroy(); return; }
      const end = data.indexOf('\n');
      if (end < 0) return;
      const raw = data.slice(0, end);
      data = '';
      void (async () => {
        try {
          const input = JSON.parse(raw);
          let value;
          if (input.action === 'ping') {
            value = { running: true, pid: process.pid, buildId, startedAt };
          } else if (input.action === 'dashboard_status') {
            value = dashboardStatus();
          } else if (input.action === 'dashboard_start') {
            value = await startDashboard({ port: input.port ?? null });
          } else if (input.action === 'dashboard_stop') {
            value = await stopDashboard();
          } else if (input.action === 'operator_analyze') {
            value = service.createOperatorAnalysis(input.name, {
              id: input.id, instruction: input.instruction,
            });
          } else if (input.action === 'daemon_shutdown') {
            const active = manager.list().filter(p => p.desiredState === 'RUNNING');
            if (active.length) throw new Error('ARIAD_DAEMON_HAS_ACTIVE_PROJECTS: stop projects first: ' + active.map(p => p.id).join(', '));
            value = { stopping: true, pid: process.pid };
            setTimeout(() => { void shutdown(); }, 100);
          } else {
            value = await control.execute(input.action, input);
          }
          conn.end(JSON.stringify({ ok: true, value }) + '\n');
        } catch (error) {
          conn.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
        }
      })();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, resolve);
  });
  chmodSync(paths.socket, 0o600);
  writeFileSync(paths.pid, process.pid + '\n');
  const writeHeartbeat = () => {
    try {
      const temporary = paths.heartbeat + '.tmp';
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, buildId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      renameSync(temporary, paths.heartbeat);
    } catch {}
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, 5000);
  heartbeatTimer.unref();
  await service.start();
  if (readConfig().dashboard?.enabled === true) {
    try { await startDashboard(); }
    catch (error) { console.error('ARIAD_DASHBOARD_START_FAILED', error); }
  }
  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    try { unlinkSync(paths.heartbeat); } catch {}
    server.close();
    if (dashboard) await dashboard.stop();
    await service.stop();
    try { unlinkSync(paths.socket); } catch {}
    try { unlinkSync(paths.pid); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  console.log('ARIAD_DAEMON_READY', root, process.pid);
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href && process.argv[2] === '--serve') {
  const root = process.argv[3] || defaultProjectsRoot(homedir());
  serveAriad(root).catch(error => { console.error(error); process.exitCode = 1; });
}
