import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';

const roles = enabled => createDefaultV2Roles({ store: {}, workspace: '/tmp', uxReviewEnabled: enabled });
test('UX reviewer is dormant unless both project binding and task opt-in exist', () => {
  const task = { ux: { required: true } };
  assert.deepEqual(roles(false).reviewer.transition({ task, result: { outcome: 'PASS' } }), { state: 'DONE' });
  assert.deepEqual(roles(true).reviewer.transition({ task: {}, result: { outcome: 'PASS' } }), { state: 'DONE' });
  assert.deepEqual(roles(true).reviewer.transition({ task, result: { outcome: 'PASS' } }), { stage: 'ux_reviewer', state: 'READY' });
  assert.deepEqual(roles(true).ux_reviewer.transition({ task, result: { outcome: 'PASS' } }), { state: 'DONE' });
  assert.deepEqual(roles(true).ux_reviewer.transition({ task, result: { outcome: 'NOT_PASS' } }), { stage: 'developer', state: 'READY' });
});


test('UX opt-in survives DB draft authoring and stays separate from art', async () => {
  const { VersionedStore } = await import('../src/v2/versioned-store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ariad-ux-spec-'));
  try {
    const vs = new VersionedStore(join(dir, 'state.db'));
    vs.initProject('ux-proj');
    vs.createDraft({ createdBy: 'tl' });
    vs.applyTreeOps([
      { op: 'upsertContract', contract: { id: 'screen', nodeType: 'feature', behavior: ['The screen renders.'] } },
      { op: 'upsertTask', task: { id: 'root', taskKind: 'FEATURE_TASK', featureId: 'screen', title: 'UX review task', intent: 'Review a screen', dependsOn: [], acceptanceCriteria: ['Screenshot meets brief'], testStrategy: 'render', ux: { required: true } } },
    ]);
    const spec = vs.listSpecTasks(vs.getOpenDraft().version).find(task => task.id === 'root');
    assert.equal(spec.ux.required, true);
    assert.equal(spec.art ?? null, null);
    vs.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('project UX flag defaults off and requires STOPPED to change', async () => {
  const { AriadProjectManager } = await import('../src/runtime/project-manager.js');
  const { ARIAD_MODEL_ROLES } = await import('../src/runtime/role-models.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ariad-ux-'));
  try {
    const manager = new AriadProjectManager({ projectsRoot: dir });
    const models = Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, 'fake/model']));
    manager.create('ux', { roleModels: models });
    assert.equal(manager.status('ux').uxReview.enabled, false);
    manager.setUxReview('ux', { enabled: true });
    assert.equal(manager.status('ux').uxReview.enabled, true);
    manager.setDesiredState('ux', 'RUNNING');
    assert.throws(() => manager.setUxReview('ux', { enabled: false }), /REQUIRES_STOPPED_PROJECT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
