import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ProjectMemoryStore } from '../src/runtime/project-memory.js';
import { codeSearch, interfaceSearch } from '../src/runtime/project-search-tools.js';
import { sessionHistory } from '../src/runtime/session-history.js';
import { ariadPiPaths } from '../src/runtime/pi-runtime-config.js';
import { piSessionManagerForSpec } from '../src/runtime/pi-agent-session-provider.js';
import { ARIAD_PROJECT_TOOL_NAMES, registerAriadProjectTools } from '../src/runtime/pi-project-tools.js';
import { AriadControlTools } from '../src/runtime/control-tools.js';
import { MemoryCurator } from '../src/runtime/memory-curator.js';
import { ARIAD_MODEL_ROLES } from '../src/runtime/role-models.js';

test('project memory binds concise memories to Ariad artifacts and searches them', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-memory-'));
  try {
    const store = new ProjectMemoryStore(workspace);
    const saved = store.remember({
      kind: 'failure_learning',
      text: 'PolicyGuard local model failed to make tool progress.',
      bindings: [
        { type: 'interface', id: 'policy.guard' },
        { type: 'task', id: 'T-policy' },
      ],
    });
    assert.equal(saved.bindings.length, 2);
    assert.equal(store.search({ artifactType: 'interface', artifactId: 'policy.guard' })[0].id, saved.id);
    assert.equal(store.search({ query: 'local model tool progress' })[0].id, saved.id);

    const duplicate = store.remember({
      kind: 'failure_learning',
      text: 'PolicyGuard local model failed to make tool progress.',
      bindings: [
        { type: 'task', id: 'T-policy' },
        { type: 'interface', id: 'policy.guard' },
      ],
    });
    assert.equal(duplicate.id, saved.id, 'exact durable memory should refresh rather than duplicate');
    store.close();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('code and interface search read current workspace facts', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-search-'));
  try {
    fs.writeFileSync(path.join(workspace, 'policy.js'), 'export function PolicyGuard() { return true; }\n');
    const dir = path.join(workspace, '.ariad', 'artifacts', 'planner', 'interfaces', 'features');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'act1.json'), JSON.stringify({
      nodeId: 'act1',
      interfaces: [{
        id: 'policy.guard',
        kind: 'executor',
        visibility: 'exported',
        contract: { input: ['request'], output: ['verdict'], sideEffects: [] },
        realization: [{ kind: 'symbol', file: 'policy.js', symbol: 'PolicyGuard' }],
        verification: [],
      }],
      imports: [],
    }));

    const code = codeSearch(workspace, 'PolicyGuard');
    assert.equal(code[0].file, 'policy.js');
    assert.match(code[0].text, /PolicyGuard/);
    fs.writeFileSync(path.join(workspace, 'use.js'), 'console.log(PolicyGuard({ allowed: true }));\n');
    const symbols = codeSearch(workspace, 'PolicyGuard', { mode: 'symbol' });
    assert.equal(symbols[0].matchKind, 'declaration');
    assert.equal(symbols[0].file, 'policy.js');

    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const fallback = codeSearch(workspace, 'PolicyGuard', { mode: 'symbol' });
      assert.equal(fallback[0].matchKind, 'declaration');
      assert.equal(fallback[0].file, 'policy.js');
    } finally {
      process.env.PATH = originalPath;
    }

    const interfaces = interfaceSearch(workspace, 'policy.guard');
    assert.equal(interfaces[0].interfaceId, 'policy.guard');
    assert.equal(interfaces[0].nodeId, 'act1');
    assert.equal(interfaces[0].realization[0].symbol, 'PolicyGuard');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Pi project tools expose code, interface, memory search and memory write', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-pi-tools-'));
  try {
    const registered = new Map();
    registerAriadProjectTools({ registerTool(tool) { registered.set(tool.name, tool); } }, { workspace });
    assert.deepEqual([...registered.keys()].sort(), [...ARIAD_PROJECT_TOOL_NAMES].sort());
    assert.equal(registered.has('ariad_session_history'), true);
    assert.equal(typeof registered.get('ariad_memory_search').execute, 'function');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});



test('fresh Pi sessions persist history without sharing context and history reader can filter them', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-history-'));
  try {
    const paths = ariadPiPaths(workspace);
    const first = piSessionManagerForSpec({
      projectId: 'P-history',
      taskId: 'T-one',
      attemptId: 'P-history:T-one:developer:1',
      role: 'developer',
      sessionPolicy: 'fresh',
    }, paths, workspace);
    first.appendMessage({ role: 'user', content: 'implement alpha memory marker', timestamp: Date.now() });
    first.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'alpha implementation completed' }], timestamp: Date.now() });
    assert.ok(first.getSessionFile());

    const second = piSessionManagerForSpec({
      projectId: 'P-history',
      taskId: 'T-two',
      attemptId: 'P-history:T-two:tester:1',
      role: 'tester',
      sessionPolicy: 'fresh',
    }, paths, workspace);
    second.appendMessage({ role: 'user', content: 'verify beta memory marker', timestamp: Date.now() });

    const developer = sessionHistory(workspace, { role: 'developer', sinceHours: 1 });
    assert.equal(developer.some(event => event.taskId === 'T-one' && event.text.includes('alpha memory marker')), true);
    assert.equal(developer.some(event => event.taskId === 'T-two'), false);

    const task = sessionHistory(workspace, { taskId: 'T-two', sinceHours: 1 });
    assert.equal(task.length, 1);
    assert.equal(task[0].role, 'tester');
    assert.match(task[0].text, /beta memory marker/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AriadControlTools delegates lifecycle actions to manager and service', async () => {
  const calls = [];
  const manager = {
    create(name, options) { calls.push(['create', name, options]); return { id: name }; },
    adopt(name, sourcePath, options) { calls.push(['adopt', name, sourcePath, options]); return { id: name, adopted: true }; },
    status(name) { return { id: name, roleModels: { developer: 'llamacpp/qwen3.8:27b' } }; },
    setRoleModels(name, roleModels) { calls.push(['set_role_models', name, roleModels]); return { id: name, roleModels }; },
  };
  const service = {
    list() { return ['P']; },
    status(name) { return { id: name }; },
    async ensureRunning(name) { calls.push(['start', name]); return { id: name, desiredState: 'RUNNING' }; },
    async ensurePaused(name) { calls.push(['pause', name]); return { id: name, desiredState: 'PAUSED' }; },
    async ensureResumed(name) { calls.push(['resume', name]); return { id: name, desiredState: 'RUNNING' }; },
    async ensureStopped(name) { calls.push(['stop', name]); return { id: name, desiredState: 'STOPPED' }; },
  };
  const tools = new AriadControlTools({ manager, service });

  assert.deepEqual(tools.list(), ['P']);
  assert.deepEqual(await tools.execute('status', { name: 'P' }), { id: 'P' });
  const models = await tools.execute('models', { name: 'P' });
  assert.equal(models.roleModels.developer, 'llamacpp/qwen3.8:27b');
  assert.equal(models.missingRoles.includes('pm'), true);
  await tools.execute('set_role_models', { name: 'P', roleModels: { pm: 'openai-codex/gpt-5.6-sol' } });
  assert.equal(calls[0][0], 'set_role_models');
  tools.takeover({ name: 'take', sourcePath: '/repo', roleModels: { developer: 'x/y' } });
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][2].mode, 'TAKEOVER');
  await tools.execute('start', { name: 'P' });
  await tools.execute('pause', { name: 'P' });
  await tools.execute('resume', { name: 'P' });
  await tools.execute('stop', { name: 'P' });
  assert.deepEqual(calls.slice(2).map(call => call[0]), ['start', 'pause', 'resume', 'stop']);
});

test('control MCP exposes external Ariad project management tool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-control-mcp-'));
  const child = spawn(process.execPath, ['src/runtime/control-mcp.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, ARIAD_PROJECTS_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const waitFor = async predicate => {
    for (let i = 0; i < 100; i += 1) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('timed out waiting for MCP response: ' + stderr);
  };

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    await waitFor(() => stdout.split('\n').find(line => line.includes('"id":1')));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    const line = await waitFor(() => stdout.split('\n').find(item => item.includes('"id":2')));
    const response = JSON.parse(line);
    assert.equal(response.result.tools[0].name, 'ariad_project');
    assert.deepEqual(
      response.result.tools[0].inputSchema.properties.action.enum,
      ['list', 'status', 'models', 'set_role_models', 'create', 'takeover', 'adopt', 'start', 'pause', 'resume', 'stop'],
    );

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ariad_project', arguments: { action: 'list' } },
    }) + '\n');
    const callLine = await waitFor(() => stdout.split('\n').find(item => item.includes('"id":3')));
    const call = JSON.parse(callLine);
    assert.deepEqual(call.result.structuredContent, []);

    const roleModels = Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'test/runtime']));
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'ariad_project',
        arguments: { action: 'create', name: 'mcp-demo', goal: 'external control', roleModels },
      },
    }) + '\n');
    const createLine = await waitFor(() => stdout.split('\n').find(item => item.includes('"id":4')));
    const created = JSON.parse(createLine);
    assert.equal(created.result.structuredContent.id, 'mcp-demo');
    assert.equal(created.result.structuredContent.desiredState, 'STOPPED');

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'ariad_project', arguments: { action: 'status', name: 'mcp-demo' } },
    }) + '\n');
    const statusLine = await waitFor(() => stdout.split('\n').find(item => item.includes('"id":5')));
    const status = JSON.parse(statusLine);
    assert.equal(status.result.structuredContent.id, 'mcp-demo');
    assert.equal(status.result.structuredContent.goal, 'external control');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('daily memory curator uses the PM model, consumes persisted history, and records success', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-curator-'));
  try {
    const paths = ariadPiPaths(workspace);
    const history = piSessionManagerForSpec({
      projectId: 'P-curator',
      taskId: 'T-real',
      attemptId: 'P-curator:T-real:developer:1',
      role: 'developer',
      sessionPolicy: 'fresh',
    }, paths, workspace);
    history.appendMessage({
      role: 'user',
      content: 'PolicyGuard must preserve a stable deny-by-default invariant.',
      timestamp: Date.now(),
    });

    const starts = [];
    let pollCount = 0;
    const provider = {
      async start(spec) {
        starts.push(spec);
        return { externalId: 'curator-1' };
      },
      async poll() {
        pollCount += 1;
        return { state: 'COMPLETED', outcome: 'PASS', summary: 'Stored one durable memory.' };
      },
      async cancel() {},
    };
    const now = new Date('2026-10-05T20:00:00.000Z');
    const curator = new MemoryCurator({ provider, now: () => now });
    const project = {
      id: 'P-curator',
      workspace,
      roleModels: { pm: 'openai-codex/gpt-5.6-sol' },
    };

    const first = await curator.tick(project);
    assert.equal(first.state, 'STARTED');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].role, 'memory_curator');
    assert.equal(starts[0].context.roleModelRef, 'openai-codex/gpt-5.6-sol');
    assert.match(starts[0].prompt, /ariad_session_history/);

    const second = await curator.tick(project);
    assert.equal(second.state, 'COMPLETED');
    assert.equal(pollCount, 1);
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.ariad', 'memory-curator.json'), 'utf8'));
    assert.equal(state.lastSuccessAt, now.toISOString());
    assert.equal(state.lastFailure, null);
    assert.equal(state.lastSummary, 'Stored one durable memory.');

    const third = await curator.tick(project);
    assert.equal(third.state, 'IDLE');
    assert.equal(starts.length, 1, 'successful daily curation must not immediately rerun');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('memory curator skips model calls when there is no recent non-maintenance history', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-curator-empty-'));
  try {
    const provider = {
      starts: 0,
      async start() { this.starts += 1; return { externalId: 'never' }; },
      async poll() { return { state: 'RUNNING' }; },
      async cancel() {},
    };
    const now = new Date('2026-10-05T20:00:00.000Z');
    const curator = new MemoryCurator({ provider, now: () => now });
    const project = {
      id: 'P-empty',
      workspace,
      roleModels: { pm: 'openai-codex/gpt-5.6-sol' },
    };
    const result = await curator.tick(project);
    assert.equal(result.state, 'SKIPPED');
    assert.equal(result.reason, 'NO_RECENT_HISTORY');
    assert.equal(provider.starts, 0);
    const state = curator.state(project);
    assert.equal(state.lastSummary, 'No recent session history to curate.');
    assert.equal(curator.isDue(project), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
