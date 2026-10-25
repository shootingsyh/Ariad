import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { V2Scheduler } from '../src/v2/scheduler.js';
import { V2Supervisor } from '../src/v2/supervisor.js';
import { RoleRegistry } from '../src/v2/role-registry.js';
import { ProviderRegistry } from '../src/v2/provider-registry.js';
import { ResourcePool } from '../src/v2/resource-pool.js';

async function scenario(failOnce) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-fake-e2e-'));
  const store = new SQLiteV2Store(join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P', deliveryEnabled: false });
    store.createNodePlanningWorkflow({ id: 'wf', projectId: 'P', phase: 'interface', reason: 'repair', scopeNodeId: 'root', nodes: [{ id: 'root', parentId: null, nodeType: 'feature' }, { id: 'leaf', parentId: 'root', nodeType: 'feature' }] });
    store.createTask({ id: 'delivery', projectId: 'P', scope: 'delivery', stage: 'developer' });
    const roles = new RoleRegistry();
    for (const role of ['tech_lead', 'plan_validator', 'tech_lead_critic', 'project_debugger', 'developer']) roles.register(role, { prepare: () => ({ provider: 'fake' }), transition: () => ({ state: 'DONE' }) });
    let sequence = 0;
    const started = [];
    const providers = new ProviderRegistry();
    providers.register({ id: 'fake', start: async spec => { started.push(spec); return { externalId: `fake-${++sequence}` }; }, poll: async () => ({ state: 'COMPLETED' }), cancel: async () => {} });
    const resources = new ResourcePool({});
    const scheduler = new V2Scheduler({ store, roles, providers, resources });
    const supervisor = new V2Supervisor({ store, providers, resources });
    let failed = false;
    for (let i = 0; i < 35 && store.getTask('wf').state !== 'DONE'; i++) {
      await scheduler.tick('P');
      for (const task of store.listTasks('P').filter(t => t.state === 'WORKING' && t.scope === 'control')) {
        let outcome = task.stage === 'tech_lead' ? 'PLANNED' : task.stage === 'tech_lead_critic' ? 'CLEAN' : 'PASS';
        if (failOnce && !failed && task.stage === 'plan_validator') { outcome = 'NOT_PASS'; failed = true; }
        store.appendTaskHistory(task.id, task.version, { type: 'ROLE_RESULT', source: 'role_result_tool', attemptId: task.execution.attemptId, role: task.stage, outcome });
      }
      await supervisor.audit('P');
    }
    assert.equal(store.getTask('wf').state, 'DONE');
    assert.equal(store.getTask('wf:2').taskKind, 'GLOBAL_REVIEW');
    assert.equal(store.getTask('delivery').state, 'READY');
    assert.equal(started.some(s => s.role === 'developer'), false);
    assert.equal(started.filter(s => s.taskId === 'wf:0' && s.role === 'tech_lead').length, failOnce ? 2 : 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('fake provider completes interface postorder and global review with delivery closed', async () => scenario(false));
test('fake provider repairs failed node validator and resumes workflow', async () => scenario(true));
