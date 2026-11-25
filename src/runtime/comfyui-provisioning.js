import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ariadInstallConfigPath } from './config-service.js';

/**
 * On-demand ComfyUI provisioning (owner design, 2026-11-25): ComfyUI is
 * a project capability, not an Ariad install dependency. Ariad itself
 * installs nothing; when a project declares features.comfyui.enabled,
 * project initialize (and the re-runnable `project provision-comfyui`)
 * detects a machine-level ComfyUI MCP environment, registers it in the
 * project's Pi agent dir (pi/mcp.json, the file the session provider
 * reads for the artist role), and smoke-checks the server before
 * reporting success. Detection order: explicit env override, the
 * install config's registered spec, a PATH lookup, then the
 * conventional comfy-official-mcp-env layout. A successful provision
 * from any non-config source records the spec into the install config,
 * so later projects detect deterministically. Nothing here installs
 * ComfyUI or the MCP environment itself: absence is a loud error.
 */

export const COMFYUI_SERVER_NAME = 'comfyui';
const PRESERVED_PREFIX = 'comfyui-bridge';

function isExecutableFile(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return existsSync(path); }
}

function specFromParts(command, args, source) {
  if (typeof command !== 'string' || !command) return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  return { command, args: list, exposure: 'direct', source };
}

export function detectComfyMcpServer({
  env = process.env,
  installConfigPath = ariadInstallConfigPath(),
  usersRoot = '/mnt/c/Users',
  pathValue = process.env.PATH ?? '',
} = {}) {
  if (env.ARIAD_COMFY_MCP_COMMAND) {
    let args = [];
    if (env.ARIAD_COMFY_MCP_ARGS) {
      try { args = JSON.parse(env.ARIAD_COMFY_MCP_ARGS); }
      catch { throw new Error('ARIAD_COMFY_MCP_ARGS is not valid JSON'); }
    }
    const spec = specFromParts(env.ARIAD_COMFY_MCP_COMMAND, args, 'env');
    if (spec) return spec;
  }
  try {
    if (existsSync(installConfigPath)) {
      const config = JSON.parse(readFileSync(installConfigPath, 'utf8'));
      const spec = specFromParts(config?.comfyMcp?.command, config?.comfyMcp?.args, 'install-config');
      if (spec) return spec;
    }
  } catch { /* an unreadable install config must not mask other sources */ }
  for (const dir of pathValue.split(':').filter(Boolean)) {
    for (const name of ['comfy-mcp', 'comfy_mcp']) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return specFromParts(candidate, [], 'path');
    }
  }
  if (existsSync(usersRoot)) {
    let users = [];
    try { users = readdirSync(usersRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { users = []; }
    for (const user of users) {
      const base = join(usersRoot, user);
      const runner = join(base, 'comfy-official-mcp-env', 'comfy_mcp_runner.py');
      const python = join(base, 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.11-windows-x86_64-none', 'python.exe');
      if (existsSync(runner) && existsSync(python)) {
        return specFromParts(python, [`C:\\Users\\${user}\\comfy-official-mcp-env\\comfy_mcp_runner.py`], 'scan:comfy-official-mcp-env');
      }
    }
  }
  return null;
}

export function registerComfyMcpInInstallConfig(spec, installConfigPath = ariadInstallConfigPath()) {
  let config = {};
  if (existsSync(installConfigPath)) {
    try { config = JSON.parse(readFileSync(installConfigPath, 'utf8')); } catch { config = {}; }
  }
  config.comfyMcp = { command: spec.command, args: spec.args };
  mkdirSync(dirname(installConfigPath), { recursive: true });
  const temporary = `${installConfigPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, installConfigPath);
  return installConfigPath;
}

export function mergeComfyuiServer(existingConfig, spec, serverName = COMFYUI_SERVER_NAME) {
  const config = (existingConfig && typeof existingConfig === 'object') ? existingConfig : {};
  const servers = { ...(config.mcpServers ?? {}) };
  const entry = { command: spec.command, args: spec.args, exposure: spec.exposure ?? 'direct' };
  let preservedAs = null;
  const current = servers[serverName];
  const same = current && current.command === entry.command
    && JSON.stringify(current.args ?? []) === JSON.stringify(entry.args);
  if (current && !same) {
    let candidate = PRESERVED_PREFIX;
    let n = 2;
    while (servers[candidate]) { candidate = `${PRESERVED_PREFIX}-${n}`; n += 1; }
    servers[candidate] = current;
    preservedAs = candidate;
  }
  servers[serverName] = entry;
  return { config: { ...config, mcpServers: servers }, preservedAs, changed: !same };
}

export function writeProjectMcpConfig(piDir, spec) {
  const path = join(piDir, 'mcp.json');
  let existing = null;
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`COMFYUI_MCP_CONFIG_INVALID: ${path}: ${error.message}`); }
  }
  const { config, preservedAs, changed } = mergeComfyuiServer(existing, spec);
  mkdirSync(piDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n');
  renameSync(temporary, path);
  return { path, preservedAs, changed, servers: Object.keys(config.mcpServers) };
}

export function smokeComfyMcpServer(spec, { timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(spec.command, spec.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      rejectPromise(new Error(`COMFYUI_MCP_SMOKE_FAILED: spawn: ${error.message}`));
      return;
    }
    let buffer = '';
    let stderrTail = '';
    let settled = false;
    const waiters = new Map();
    let seq = 0;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      rejectPromise(new Error(`COMFYUI_MCP_SMOKE_FAILED: ${message}${stderrTail ? ` (stderr: ${stderrTail.slice(-300)})` : ''}`));
    };
    const timer = setTimeout(() => fail(`no tools/list response within ${timeoutMs}ms`), timeoutMs);
    child.on('error', error => { clearTimeout(timer); fail(`spawn: ${error.message}`); });
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-1200); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && waiters.has(msg.id)) { const done = waiters.get(msg.id); waiters.delete(msg.id); done(msg); }
      }
    });
    const send = (method, params) => new Promise(done => {
      seq += 1;
      waiters.set(seq, done);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: seq, method, params }) + '\n');
    });
    (async () => {
      const init = await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ariad-provisioning', version: '1' },
      });
      if (settled) return;
      if (init.error) { clearTimeout(timer); fail(`initialize: ${JSON.stringify(init.error).slice(0, 200)}`); return; }
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listed = await send('tools/list', {});
      if (settled) return;
      clearTimeout(timer);
      const toolNames = (listed.result?.tools ?? []).map(tool => tool.name).filter(Boolean);
      if (!toolNames.length) { fail('tools/list returned no tools'); return; }
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolvePromise({ serverName: init.result?.serverInfo?.name ?? null, toolNames });
    })().catch(error => { clearTimeout(timer); fail(error.message); });
  });
}

export async function provisionProjectComfyui({
  workspace,
  spec = null,
  smoke = true,
  installConfigPath = ariadInstallConfigPath(),
  detectOptions = {},
} = {}) {
  if (!workspace) throw new Error('workspace is required');
  const detected = spec ?? detectComfyMcpServer({ installConfigPath, ...detectOptions });
  if (!detected) {
    throw new Error(
      'COMFYUI_MCP_NOT_DETECTED: this project declares the comfyui capability but no ComfyUI MCP environment was found on this machine '
      + '(looked at ARIAD_COMFY_MCP_COMMAND, the install config, PATH, and the conventional comfy-official-mcp-env layout). '
      + 'Install or register one, then re-run: ariad project provision-comfyui <name>',
    );
  }
  const piDir = join(workspace, '.ariad', 'pi');
  const written = writeProjectMcpConfig(piDir, detected);
  let smokeResult = null;
  if (smoke) smokeResult = await smokeComfyMcpServer(detected);
  let registeredInInstallConfig = false;
  if (detected.source && detected.source !== 'install-config') {
    try { registerComfyMcpInInstallConfig(detected, installConfigPath); registeredInInstallConfig = true; } catch { /* registration is a cache, never the deliverable */ }
  }
  return {
    provisioned: true,
    serverName: COMFYUI_SERVER_NAME,
    source: detected.source ?? 'explicit',
    command: detected.command,
    args: detected.args,
    mcpConfigPath: written.path,
    configChanged: written.changed,
    preservedAs: written.preservedAs,
    servers: written.servers,
    registeredInInstallConfig,
    smoke: smokeResult ? { serverName: smokeResult.serverName, toolCount: smokeResult.toolNames.length, toolNames: smokeResult.toolNames } : null,
  };
}
