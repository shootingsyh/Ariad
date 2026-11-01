import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bundledPiMcpExtensionPath,
  createDefaultPiRunSession,
  readProjectMcpServers,
} from '../src/runtime/pi-agent-session-provider.js';

const FAKE_MCP_SERVER = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }) + '\\n');
  } else if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (m.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } }) + '\\n');
  } else if (m.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } }) + '\\n');
  }
});
`;

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-mcp-wiring-'));
  const workspace = path.join(root, 'workspace');
  const piDir = path.join(workspace, '.ariad', 'pi');
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, 'models.json'), JSON.stringify({
    providers: {
      fake: {
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        apiKey: 'test',
        models: [{ id: 'runtime', name: 'runtime', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 512 }],
      },
    },
  }) + '\n');
  return { root, workspace, piDir };
}

function specFor(workspace, role) {
  return {
    projectId: 'mcp-wiring-test',
    taskId: 'T1',
    role,
    workspace,
    context: { roleModelRef: 'fake/runtime', preservePiConfig: true, roleModels: {} },
  };
}

async function waitForTools(session, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = (session.getAllTools?.() ?? []).map(t => t.name ?? t);
    if (predicate(names)) return names;
    await new Promise(r => setTimeout(r, 250));
  }
  return (session.getAllTools?.() ?? []).map(t => t.name ?? t);
}

test('readProjectMcpServers parses the mcpServers shape and filters junk', () => {
  const { piDir } = tempWorkspace();
  fs.writeFileSync(path.join(piDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      good: { command: '/bin/true' },
      junk: 'nope',
      alsoGood: { url: 'http://127.0.0.1:1/mcp' },
    },
  }));
  const servers = readProjectMcpServers(piDir);
  assert.deepEqual(servers.map(([name]) => name), ['good', 'alsoGood']);
});

test('readProjectMcpServers tolerates missing and malformed files', () => {
  const { piDir } = tempWorkspace();
  assert.deepEqual(readProjectMcpServers(piDir), []);
  fs.writeFileSync(path.join(piDir, 'mcp.json'), '{not json');
  assert.deepEqual(readProjectMcpServers(piDir), []);
  fs.writeFileSync(path.join(piDir, 'mcp.json'), JSON.stringify({ nope: {} }));
  assert.deepEqual(readProjectMcpServers(piDir), []);
});

test('bundledPiMcpExtensionPath resolves to an existing file or null', () => {
  const resolved = bundledPiMcpExtensionPath();
  assert.ok(resolved === null || fs.existsSync(resolved), `expected existing path or null, got ${resolved}`);
});

test('artist session activates the project MCP server tools; developer session does not', async (t) => {
  const { workspace, piDir } = tempWorkspace();
  const serverPath = path.join(piDir, 'fake-mcp-server.mjs');
  fs.writeFileSync(serverPath, FAKE_MCP_SERVER);
  fs.writeFileSync(path.join(piDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      fake: { command: process.execPath, args: [serverPath], exposure: 'direct' },
    },
  }));

  const artist = await createDefaultPiRunSession(specFor(workspace, 'artist'));
  t.after(() => {
    try { artist.session.dispose?.(); } catch { /* best effort */ }
    // Session dispose does not emit session_shutdown, so the MCP child would
    // outlive the test process; reap the fixture server explicitly.
    try { execFileSync('pkill', ['-f', serverPath]); } catch { /* already gone */ }
  });
  const artistTools = await waitForTools(artist.session, names => names.includes('mcp__fake__ping'), 20000);
  assert.ok(artistTools.includes('mcp__fake__ping'), `artist tools missing MCP tool: ${artistTools.join(',')}`);
  assert.ok(
    (artist.session.getActiveToolNames?.() ?? []).includes('mcp__fake__ping'),
    'MCP tool registered but not active in the artist session',
  );

  const developer = await createDefaultPiRunSession(specFor(workspace, 'developer'));
  t.after(() => { try { developer.session.dispose?.(); } catch { /* best effort */ } });
  await new Promise(r => setTimeout(r, 5000));
  const developerTools = (developer.session.getAllTools?.() ?? []).map(x => x.name ?? x);
  assert.ok(!developerTools.some(name => String(name).startsWith('mcp__')), `developer session must not register MCP servers: ${developerTools.join(',')}`);
});
