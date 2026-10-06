#!/usr/bin/env node
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, unlinkSync, chmodSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { AriadProjectManager, defaultProjectsRoot } from './project-manager.js';
import { AriadService } from './ariad-service.js';
import { PiAgentSessionProvider } from './pi-agent-session-provider.js';
import { createAriadControlTools } from './control-tools.js';
import { AriadDashboardService } from './dashboard-service.js';

export function daemonPaths(root) {
  const dir = join(root, '.runtime');
  return { dir, socket: join(dir, 'ariad.sock'), pid: join(dir, 'ariad.pid'), log: join(dir, 'ariad.log'), config: join(dir, 'config.json') };
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

export async function ensureAriadDaemon(root, { timeoutMs = 8000 } = {}) {
  try { await daemonRequest(root, { action: 'ping' }, { timeoutMs: 1500 }); return daemonPaths(root); }
  catch {}
  const paths = daemonPaths(root);
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
      await daemonRequest(root, { action: 'ping' }, { timeoutMs: 500 });
      return paths;
    } catch {}
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
            value = { running: true, pid: process.pid };
          } else if (input.action === 'dashboard_status') {
            value = dashboardStatus();
          } else if (input.action === 'dashboard_start') {
            value = await startDashboard({ port: input.port ?? null });
          } else if (input.action === 'dashboard_stop') {
            value = await stopDashboard();
          } else if (input.action === 'daemon_shutdown') {
            const active = manager.list().filter(p => p.desiredState !== 'STOPPED');
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
  await service.start();
  if (readConfig().dashboard?.enabled === true) {
    try { await startDashboard(); }
    catch (error) { console.error('ARIAD_DASHBOARD_START_FAILED', error); }
  }
  const shutdown = async () => {
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
