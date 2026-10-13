import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteV2Store } from '../src/v2/sqlite-store.js';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';
import { ensureInterfaceArtifactLayout } from '../src/v2/interface-contracts.js';

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};
const node = (id, parentId) => ({ id, parentId, title: id, summary: id });
const contract = id => ({ version: 1, nodeId: id, nodeType: 'feature', decomposition: { kind: 'leaf', reason: 'bounded' }, interfaces: [], imports: [], integrationScenarios: [] });

test('workflow validator rejects missing target, scope drift, missing contract and empty artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-node-validator-'));
  const store = new SQLiteV2Store(path.join(dir, 'state.db'));
  try {
    store.createProject({ id: 'P' });
    const artifactRoot = path.join(dir, 'artifacts');
    const layout = ensureInterfaceArtifactLayout(artifactRoot);
    const definitions = createDefaultV2Roles({ store, workspace: dir, artifactRoot, providerId: 'fake', codeProviderId: 'ariad-code' });
    const run = (nodeId, nodes, taskKind = 'NODE_PLANNING') => definitions.plan_validator.prepare({ task: { id: 'validator', projectId: 'P', taskKind, stage: 'plan_validator', input: { purpose: 'NODE_PLANNING_WORKFLOW', phase: 'feature', nodeId, nodes } } }).execute();
    const root = node('root', null);
    const child = node('child', 'root');
    assert.match((await run('root', [root])).result.error, /WORKFLOW_NODE_MISSING/);
    write(path.join(artifactRoot, 'planner', 'logical', 'root.json'), root);
    assert.match((await run('root', [root])).result.error, /WORKFLOW_CONTRACT_MISSING/);
    write(path.join(layout.featureDir, 'root.json'), contract('root'));
    assert.equal((await run('root', [root])).outcome, 'PASS');
    assert.match((await run('root', [node('root', 'other')])).result.error, /WORKFLOW_NODE_SCOPE_MISMATCH/);
    assert.match((await run('child', [root, child])).result.error, /WORKFLOW_NODE_MISSING/);
    write(path.join(artifactRoot, 'planner', 'logical', 'child.json'), child);
    assert.match((await run('child', [root, child])).result.error, /WORKFLOW_CONTRACT_MISSING/);
    write(path.join(layout.featureDir, 'child.json'), contract('child'));
    write(path.join(layout.featureDir, 'root.json'), { ...contract('root'), decomposition: { kind: 'expand', reason: 'child decomposition' } });
    assert.equal((await run('child', [root, child])).outcome, 'PASS');
    assert.equal((await run('root', [root, child], 'GLOBAL_REVIEW')).outcome, 'PASS');
  } finally {
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
