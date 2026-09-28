import test from 'node:test';
import assert from 'node:assert/strict';
import { artCapabilityRecommendations, requiredArtCapabilities } from '../src/v2/art-capabilities.js';
import { validateTechLeadPlan } from '../src/v2/tech-lead-plan.js';

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

  const validated = validateTechLeadPlan({
    version: 2,
    projectSummary: 'Art flow',
    rootTaskId: 'ROOT',
    tasks: [
      {
        id: 'ROOT', title: 'Root', intent: 'Finish', parentId: null, dependsOn: [],
        acceptanceCriteria: ['done'], testStrategy: 'review',
      },
      {
        id: 'T1', title: 'Media', intent: 'Create media', parentId: 'ROOT', dependsOn: [],
        acceptanceCriteria: ['assets ready'], testStrategy: 'screenshot and audio review', art,
      },
    ],
  });
  assert.deepEqual(validated.plan.tasks.find(task => task.id === 'T1').art, art);
});
