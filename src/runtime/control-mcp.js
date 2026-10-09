#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { AriadProjectManager, defaultProjectsRoot } from './project-manager.js';
import { AriadService } from './ariad-service.js';
import { PiAgentSessionProvider } from './pi-agent-session-provider.js';
import { createAriadControlTools } from './control-tools.js';

const projectsRoot = resolve(process.env.ARIAD_PROJECTS_ROOT || defaultProjectsRoot(homedir()));
const manager = new AriadProjectManager({ projectsRoot });
const provider = new PiAgentSessionProvider();
const service = new AriadService({
  manager,
  provider,
  reconcileWakePath: join(projectsRoot, '.runtime', 'reconcile.wake'),
});
const control = createAriadControlTools({ manager, service });

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'status', 'models', 'set_role_models', 'create', 'takeover', 'adopt', 'start', 'pause', 'soft_stop', 'resume', 'stop', 'open_issue', 'list_issues'],
    },
    name: { type: 'string' },
    goal: { type: ['string', 'null'] },
    sourcePath: { type: 'string' },
    roleModels: { type: 'object', additionalProperties: { type: 'string' } },
    states: { type: 'array', items: { type: 'string' } },
    issue: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'description'],
      properties: {
        id: { type: ['string', 'null'] },
        source: {
          type: 'object',
          additionalProperties: true,
          properties: { kind: { type: 'string' }, ref: { type: ['string', 'null'] } },
        },
        sourceTaskId: { type: ['string', 'null'] },
        reportedBy: { type: ['string', 'null'] },
        title: { type: 'string' },
        description: { type: 'string' },
        evidence: { type: 'array' },
        severity: { type: 'string' },
        blocking: { type: 'boolean' },
        affectedComponent: { type: ['string', 'null'] },
        affectedInterface: { type: ['string', 'null'] },
        fingerprint: { type: ['string', 'null'] },
        context: { type: ['object', 'null'], additionalProperties: true },
      },
    },
  },
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function shutdown() {
  try { await service.stop(); } finally { process.exit(0); }
}

async function main() {
  await service.start();
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) void handle(line);
    }
  });

  async function handle(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const { id, method, params } = message;
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ariad-control', version: '1.0.0' },
      });
      return;
    }
    if (method === 'ping') { reply(id, {}); return; }
    if (method === 'tools/list') {
      reply(id, {
        tools: [{
          name: 'ariad_project',
          description: 'Manage Ariad projects from outside the role runtime: inspect/configure models, create/takeover/adopt, start, pause/soft-stop, resume, or hard stop. soft_stop finishes active role work but schedules no new work; stop cancels active work.',
          inputSchema,
        }],
      });
      return;
    }
    if (method === 'tools/call') {
      if (params?.name !== 'ariad_project') { fail(id, -32602, 'unknown tool'); return; }
      try {
        const args = params?.arguments ?? {};
        const value = await control.execute(args.action, args);
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
        });
      } catch (error) {
        reply(id, {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        });
      }
      return;
    }
    fail(id, -32601, 'method not found');
  }
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
