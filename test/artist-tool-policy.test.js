import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultV2Roles } from '../src/v2/default-roles.js';

function fakeStore() {
  return {
    listTasks: () => [],
    listPlanningRequests: () => [],
    listIncidents: () => [],
    getProject: () => ({ id: 'p1' }),
  };
}

test('artist prompt prefers ComfyUI MCP and avoids detached image_generate when available', () => {
  const roles = createDefaultV2Roles({
    store: fakeStore(),
    workspace: '/tmp/ariad-artist-policy',
  });
  const prepared = roles.artist.prepare({
    task: {
      id: 'art-1',
      projectId: 'p1',
      stage: 'artist',
      art: { required: true, media: ['image'], placeholderAllowed: false },
      history: [],
    },
  });
  const prompt = prepared.context.v2Prompt;
  assert.match(prompt, /Inspect the actual tool surface available in this run/);
  assert.match(prompt, /prefer configured ComfyUI MCP tools/);
  assert.match(prompt, /Do not use OpenClaw image_generate when ComfyUI MCP is available/);
  assert.match(prompt, /drop run-scoped tools/);
  assert.deepEqual(prepared.context.capabilityRequirements, ['image.create', 'image.review']);
});

test('artist policy still allows NEEDS_CAPABILITY when ComfyUI MCP is genuinely unavailable', () => {
  const roles = createDefaultV2Roles({
    store: fakeStore(),
    workspace: '/tmp/ariad-artist-policy',
  });
  const prepared = roles.artist.prepare({
    task: {
      id: 'art-2',
      projectId: 'p1',
      stage: 'artist',
      art: { required: true, media: ['image'], placeholderAllowed: false },
      history: [],
    },
  });
  assert.match(prepared.context.v2Prompt, /when ComfyUI MCP is genuinely unavailable/);
  assert.match(prepared.context.v2Prompt, /If a required capability is unavailable, return NEEDS_CAPABILITY/);
});
