#!/usr/bin/env node
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const response = await fetch(`http://127.0.0.1:${port}/role-result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `Ariad bridge returned HTTP ${response.status}`);
  return body;
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
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
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
