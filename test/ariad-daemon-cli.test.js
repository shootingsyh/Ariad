import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAriadRuntimeCli } from '../src/runtime/cli.js';

const roles = ['artist', 'developer', 'tester', 'reviewer', 'project_debugger', 'tech_lead', 'tech_lead_critic', 'pm'];

test('standalone CLI controls detached daemon and projects without OpenClaw', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-daemon-cli-'));
  const args = (...parts) => [...parts, '--projects-root', root];
  try {
    const config = await runAriadRuntimeCli(args('config', 'local-endpoint', 'http://127.0.0.1:11434/v1'));
    assert.ok(fs.existsSync(config.config));
    const started = await runAriadRuntimeCli(args('daemon', 'start'));
    assert.equal(started.running, true);
    const ping = await runAriadRuntimeCli(args('daemon', 'status'));
    assert.equal(ping.running, true);

    const roleModels = Object.fromEntries(roles.map(role => [role, 'llamacpp/fake-local']));
    const created = await runAriadRuntimeCli(args('project', 'create', 'test-project', '--goal', 'CLI test', '--role-models', JSON.stringify(roleModels)));
    assert.equal(created.id, 'test-project');
    assert.equal(created.desiredState, 'STOPPED');

    const updated = await runAriadRuntimeCli(args('project', 'set-role-models', 'test-project', JSON.stringify({ reviewer: 'openai-codex/test' })));
    assert.equal(updated.roleModels.reviewer, 'openai-codex/test');

    const status = await runAriadRuntimeCli(args('project', 'status', 'test-project'));
    assert.equal(status.roleModels.reviewer, 'openai-codex/test');
    assert.equal(status.desiredState, 'STOPPED');

    const stopped = await runAriadRuntimeCli(args('daemon', 'stop'));
    assert.equal(stopped.stopping, true);
  } finally {
    try {
      const pidFile = path.join(root, '.runtime', 'ariad.pid');
      if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
