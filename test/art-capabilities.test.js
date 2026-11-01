import test from 'node:test';
import assert from 'node:assert/strict';
import { artCapabilityRecommendations, requiredArtCapabilities } from '../src/v2/art-capabilities.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionedStore } from '../src/v2/versioned-store.js';

test('art tasks declare media capabilities and retain art planning metadata', () => {
  const art = {
    required: true,
    media: ['image', 'music'],
    deliverables: ['hero.png', 'theme.ogg'],
    placeholderAllowed: false,
  };
  assert.deepEqual(requiredArtCapabilities(art), [
    'image.create', 'image.review', 'music.create', 'music.review',
  ]);
  const recommendations = artCapabilityRecommendations(requiredArtCapabilities(art));
  assert.equal(recommendations[0].capability, 'image.create');
  assert.ok(recommendations[0].recommendations.length > 0);

  const dir = mkdtempSync(join(tmpdir(), 'ariad-art-spec-'));
  try {
    const vs = new VersionedStore(join(dir, 'state.db'));
    vs.initProject('art-proj');
    vs.createDraft({ createdBy: 'tl' });
    vs.applyTreeOps([
      { op: 'upsertContract', contract: { id: 'media', nodeType: 'feature', behavior: ['Media assets exist.'] } },
      { op: 'upsertTask', task: { id: 'ROOT', taskKind: 'MILESTONE_TASK', title: 'Root', intent: 'Finish', acceptanceCriteria: ['done'], testStrategy: 'review' } },
      { op: 'upsertTask', task: { id: 'T1', taskKind: 'FEATURE_TASK', featureId: 'media', title: 'Media', intent: 'Create media', parentId: 'ROOT', dependsOn: [], acceptanceCriteria: ['assets ready'], testStrategy: 'screenshot and audio review', art } },
    ]);
    const spec = vs.listSpecTasks(vs.getOpenDraft().version).find(task => task.id === 'T1');
    assert.deepEqual(spec.art, art);
    vs.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
