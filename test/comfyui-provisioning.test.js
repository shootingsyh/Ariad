import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectComfyMcpServer,
  mergeComfyuiServer,
  provisionProjectComfyui,
  smokeComfyMcpServer,
  writeProjectMcpConfig,
} from '../src/runtime/comfyui-provisioning.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ariad-comfyui-')); }

const FAKE_SERVER = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'fake-comfy' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'generate_image' }, { name: 'install_node' }] } }) + '\\n');
  }
});
`;

function fakeSpec(dir) {
  const script = join(dir, 'fake-mcp.mjs');
  writeFileSync(script, FAKE_SERVER);
  return { command: process.execPath, args: [script], exposure: 'direct', source: 'test' };
}

test('detect: env override wins', () => {
  const spec = detectComfyMcpServer({
    env: { ARIAD_COMFY_MCP_COMMAND: '/bin/fake', ARIAD_COMFY_MCP_ARGS: '["--x"]' },
    installConfigPath: join(tmp(), 'nope.json'),
    usersRoot: join(tmp(), 'no-users'),
    pathValue: '',
  });
  assert.equal(spec.command, '/bin/fake');
  assert.deepEqual(spec.args, ['--x']);
  assert.equal(spec.source, 'env');
});

test('detect: install config registration is used', () => {
  const dir = tmp();
  const cfg = join(dir, 'ariad-config.json');
  writeFileSync(cfg, JSON.stringify({ comfyMcp: { command: '/opt/comfy-mcp', args: ['serve'] } }));
  const spec = detectComfyMcpServer({ env: {}, installConfigPath: cfg, usersRoot: join(dir, 'no-users'), pathValue: '' });
  assert.equal(spec.command, '/opt/comfy-mcp');
  assert.equal(spec.source, 'install-config');
});

test('detect: conventional comfy-official-mcp-env layout is found', () => {
  const dir = tmp();
  const userDir = join(dir, 'Users', 'someone');
  mkdirSync(join(userDir, 'comfy-official-mcp-env'), { recursive: true });
  mkdirSync(join(userDir, 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.11-windows-x86_64-none'), { recursive: true });
  writeFileSync(join(userDir, 'comfy-official-mcp-env', 'comfy_mcp_runner.py'), '# runner');
  writeFileSync(join(userDir, 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.11-windows-x86_64-none', 'python.exe'), 'MZ');
  const spec = detectComfyMcpServer({ env: {}, installConfigPath: join(dir, 'nope.json'), usersRoot: join(dir, 'Users'), pathValue: '' });
  assert.equal(spec.source, 'scan:comfy-official-mcp-env');
  assert.deepEqual(spec.args, ['C:\\Users\\someone\\comfy-official-mcp-env\\comfy_mcp_runner.py']);
});

test('detect: nothing found returns null', () => {
  const spec = detectComfyMcpServer({
    env: {},
    installConfigPath: join(tmp(), 'nope.json'),
    usersRoot: join(tmp(), 'no-users'),
    pathValue: '',
  });
  assert.equal(spec, null);
});

test('merge: an existing different comfyui entry is preserved as comfyui-bridge', () => {
  const existing = {
    mcpServers: {
      comfyui: { command: '/bridge/index.mjs', args: [], exposure: 'direct' },
      audio: { command: '/audio/index.mjs', args: [], exposure: 'direct' },
    },
  };
  const spec = { command: '/official/python', args: ['runner.py'] };
  const { config, preservedAs, changed } = mergeComfyuiServer(existing, spec);
  assert.equal(changed, true);
  assert.equal(preservedAs, 'comfyui-bridge');
  assert.equal(config.mcpServers.comfyui.command, '/official/python');
  assert.equal(config.mcpServers['comfyui-bridge'].command, '/bridge/index.mjs');
  assert.equal(config.mcpServers.audio.command, '/audio/index.mjs');
  const again = mergeComfyuiServer(config, spec);
  assert.equal(again.changed, false);
  assert.equal(again.preservedAs, null);
});

test('write: creates pi/mcp.json and keeps unrelated top-level keys', () => {
  const dir = tmp();
  const piDir = join(dir, 'pi');
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, 'mcp.json'), JSON.stringify({ other: 1, mcpServers: {} }));
  const result = writeProjectMcpConfig(piDir, { command: '/x', args: [] });
  const written = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(written.other, 1);
  assert.equal(written.mcpServers.comfyui.command, '/x');
});

test('smoke: handshake returns the server tool names', async () => {
  const spec = fakeSpec(tmp());
  const result = await smokeComfyMcpServer(spec, { timeoutMs: 10000 });
  assert.equal(result.serverName, 'fake-comfy');
  assert.deepEqual(result.toolNames, ['generate_image', 'install_node']);
});

test('smoke: a missing binary fails loudly', async () => {
  await assert.rejects(
    smokeComfyMcpServer({ command: '/nonexistent/comfy-mcp', args: [] }, { timeoutMs: 5000 }),
    /COMFYUI_MCP_SMOKE_FAILED/,
  );
});

test('provision: writes config, preserves the bridge, smokes, self-registers', async () => {
  const dir = tmp();
  const workspace = join(dir, 'ws');
  const piDir = join(workspace, '.ariad', 'pi');
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, 'mcp.json'), JSON.stringify({
    mcpServers: { comfyui: { command: '/bridge/index.mjs', args: ['b'], exposure: 'direct' } },
  }));
  const installConfigPath = join(dir, 'ariad-config.json');
  const result = await provisionProjectComfyui({
    workspace,
    spec: fakeSpec(dir),
    installConfigPath,
  });
  assert.equal(result.provisioned, true);
  assert.equal(result.preservedAs, 'comfyui-bridge');
  assert.equal(result.smoke.toolCount, 2);
  assert.equal(result.registeredInInstallConfig, true);
  const config = JSON.parse(readFileSync(join(piDir, 'mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.comfyui.command, process.execPath);
  assert.equal(config.mcpServers['comfyui-bridge'].command, '/bridge/index.mjs');
  const install = JSON.parse(readFileSync(installConfigPath, 'utf8'));
  assert.equal(install.comfyMcp.command, process.execPath);
});

test('provision: no detectable environment is a loud initialize error', async () => {
  const dir = tmp();
  await assert.rejects(
    provisionProjectComfyui({
      workspace: join(dir, 'ws'),
      installConfigPath: join(dir, 'nope.json'),
      detectOptions: { env: {}, usersRoot: join(dir, 'no-users'), pathValue: '' },
    }),
    /COMFYUI_MCP_NOT_DETECTED/,
  );
});
