#!/usr/bin/env node
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'NODE_USE_ENV_PROXY',
];

if (process.env.ARIAD_MCP_PROXY_SCRUBBED !== '1' && PROXY_ENV_KEYS.some(key => process.env[key])) {
  const env = { ...process.env, ARIAD_MCP_PROXY_SCRUBBED: '1' };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  const child = spawn(process.execPath, process.argv.slice(1), {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on('error', error => {
    process.stderr.write(`Failed to restart Ariad MCP without proxy environment: ${error.message}\n`);
    process.exit(1);
  });
} else {
  serve();
}

function serve() {
  const projectsRoot = process.env.ARIAD_PROJECTS_ROOT || join(homedir(), '.openclaw', 'ariad', 'projects');
  const tokenFile = join(projectsRoot, '.runtime', 'mcp-role-result-token');
  const port = Number(process.env.ARIAD_MCP_ROLE_RESULT_PORT || 18792);

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['attemptId', 'outcome', 'summary'],
    properties: {
      attemptId: { type: 'string', minLength: 1, description: 'Exact Ariad attemptId from ARIAD RUNTIME CONTEXT.' },
      outcome: { type: 'string', minLength: 1 },
      summary: { type: 'string', minLength: 1 },
      keyPoints: { type: 'array', items: { type: 'string' } },
      artifacts: { type: 'array', items: { type: 'string' } },
      result: {},
    },
  };

  function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  function fail(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  async function submit(args) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    const payload = JSON.stringify(args);
    return await new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: '/role-result',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => {
          let body;
          try { body = JSON.parse(text); } catch { body = { error: text }; }
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            reject(new Error(body?.error || `Ariad bridge returned HTTP ${status}`));
            return;
          }
          resolve(body);
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      void handle(line);
    }
  });

  async function handle(line) {
    let requestMessage;
    try { requestMessage = JSON.parse(line); } catch { return; }
    const { id, method, params } = requestMessage;
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ariad-role-result', version: '1.0.0' },
      });
      return;
    }
    if (method === 'ping') { reply(id, {}); return; }
    if (method === 'tools/list') {
      reply(id, { tools: [{
        name: 'ariad_role_result',
        description: 'Submit the authoritative structured result for the active Ariad role attempt. Use the exact attemptId from ARIAD RUNTIME CONTEXT. The server derives the role from the active attempt binding; do not encode or guess a role.',
        inputSchema: schema,
      }] });
      return;
    }
    if (method === 'tools/call') {
      if (params?.name !== 'ariad_role_result') { fail(id, -32602, 'unknown tool'); return; }
      try {
        const value = await submit(params?.arguments || {});
        reply(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
      } catch (error) {
        reply(id, { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] });
      }
      return;
    }
    fail(id, -32601, 'method not found');
  }
}
