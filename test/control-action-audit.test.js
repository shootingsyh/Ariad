import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AriadProjectManager } from '../src/runtime/project-manager.js';
import { ARIAD_MODEL_ROLES } from '../src/runtime/role-models.js';

test('lifecycle audit persists actor source, request and every transition including no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-action-audit-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: root });
    const models = Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'fake/model']));
    const project = manager.create('audit-test', { roleModels: models });
    manager.setDesiredState('audit-test', 'RUNNING', { action: 'RESUME', source: 'cli', requestId: 'r1' });
    manager.setDesiredState('audit-test', 'RUNNING', { action: 'START', source: 'dashboard', requestId: 'r2' });
    manager.setDesiredState('audit-test', 'PAUSED', { action: 'SOFT_STOP', source: 'cli', requestId: 'r3' });
    const entries = readFileSync(join(project.workspace, '.ariad', 'control-actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(entries.map(e => [e.action, e.source, e.from, e.to, e.changed]), [
      ['RESUME', 'cli', 'STOPPED', 'RUNNING', true],
      ['START', 'dashboard', 'RUNNING', 'RUNNING', false],
      ['SOFT_STOP', 'cli', 'RUNNING', 'PAUSED', true],
    ]);
    assert.equal(entries[0].requestId, 'r1');
    assert.ok(entries[0].at);
    assert.equal(manager.status('audit-test').desiredState, 'PAUSED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
