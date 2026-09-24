import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverScript = fileURLToPath(new URL('../runtime/ariad-role-result-mcp.js', import.meta.url));

test('role-result MCP reaches loopback bridge even with poisoned proxy environment', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-mcp-proxy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, '.runtime');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'mcp-role-result-token'), 'test-token\n', { mode: 0o600 });

  let bridgeHit = false;
  const bridge = createServer((req, res) => {
    bridgeHit = true;
    assert.equal(req.url, '/role-result');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const args = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, attemptId: args.attemptId }));
    });
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => bridge.close());
  const { port } = bridge.address();

  const deadProxy = 'http://127.0.0.1:1';
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      ARIAD_PROJECTS_ROOT: root,
      ARIAD_MCP_ROLE_RESULT_PORT: String(port),
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: deadProxy,
      HTTPS_PROXY: deadProxy,
      ALL_PROXY: deadProxy,
      http_proxy: deadProxy,
      https_proxy: deadProxy,
      all_proxy: deadProxy,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ariad_role_result',
      arguments: { attemptId: 'proxy-test', outcome: 'PLANNED', summary: 'proxy bypass test' },
    },
  }) + '\n');

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP call timed out; stderr=${stderr}`)), 3000);
    const poll = () => {
      const line = stdout.split('\n').find(value => value.trim());
      if (!line) { setTimeout(poll, 10); return; }
      clearTimeout(timer);
      resolve(JSON.parse(line));
    };
    poll();
  });

  assert.equal(bridgeHit, true);
  assert.equal(result.id, 1);
  assert.equal(result.result?.structuredContent?.accepted, true);
  assert.equal(result.result?.structuredContent?.attemptId, 'proxy-test');
});
