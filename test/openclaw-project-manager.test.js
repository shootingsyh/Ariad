import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AriadProjectManager, slugify } from '../extensions/openclaw-ariad/runtime/project-manager.js';

test('OpenClaw Ariad project manager isolates project folders and durable desired state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-openclaw-'));
  const manager = new AriadProjectManager({
    projectsRoot: join(dir, 'projects'),
    now: () => new Date('2026-09-16T12:00:00.000Z'),
  });

  try {
    const alpha = manager.create('Alpha Project', {
      goal: 'build alpha',
      projectAgent: { host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:alpha' },
    });
    const beta = manager.create('Beta Project', { goal: 'build beta' });

    assert.equal(alpha.id, 'alpha-project');
    assert.equal(beta.id, 'beta-project');
    assert.notEqual(alpha.root, beta.root);
    assert.notEqual(alpha.workspace, beta.workspace);
    assert.notEqual(alpha.stateDb, beta.stateDb);
    assert.ok(existsSync(join(alpha.root, 'workspace')));
    assert.ok(existsSync(join(beta.root, 'workspace')));
    assert.equal(alpha.desiredState, 'STOPPED');
    assert.equal(beta.desiredState, 'STOPPED');

    manager.setDesiredState('alpha-project', 'RUNNING');
    assert.equal(manager.status('alpha-project').desiredState, 'RUNNING');
    assert.equal(manager.status('beta-project').desiredState, 'STOPPED');
    manager.setDesiredState('beta-project', 'RUNNING');
    manager.setDesiredState('alpha-project', 'STOPPED');
    assert.equal(manager.status('alpha-project').desiredState, 'STOPPED');
    assert.equal(manager.status('beta-project').desiredState, 'RUNNING', 'stopping one project must not affect another');

    const listed = manager.list();
    assert.deepEqual(listed.map((p) => p.id).sort(), ['alpha-project', 'beta-project']);
    assert.match(readFileSync(join(beta.root, 'project.json'), 'utf8'), /build beta/);
    assert.deepEqual(manager.status('alpha-project').projectAgent, {
      host: 'openclaw', agentId: 'main', sessionKey: 'agent:main:alpha',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project ids cannot escape the configured projects root', () => {
  assert.equal(slugify('../My Project'), '..-my-project');
  assert.throws(() => slugify('..'), /letters or numbers/);
  assert.throws(() => slugify('---'), /letters or numbers/);
});

test('OpenClaw plugin manifest owns exactly one Ariad tool and starts with Gateway', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/openclaw-ariad/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'ariad');
  assert.deepEqual(manifest.contracts.tools, ['ariad_project']);
  assert.equal(manifest.activation.onStartup, true);
});
