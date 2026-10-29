import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { buildTaskContextArtifact } from '../src/runtime/task-context-artifact.js';
import { ProjectMemoryStore } from '../src/runtime/project-memory.js';

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'ariad-mem-'));
  const workspace = join(root, 'proj', 'workspace');
  const artifactRoot = join(workspace, '.ariad', 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  return { workspace, artifactRoot };
}

const TASK = { id: 'T1', title: 't', interfaceIds: ['iface-1'], logicalRefs: ['feat-1'], history: [] };

test('artifact injects memories bound to the task interfaces, features, and the task itself', () => {
  const { workspace, artifactRoot } = makeWorkspace();
  const store = new ProjectMemoryStore(workspace);
  store.remember({ text: 'Run the audio manifest test after data changes.', kind: 'lesson', bindings: [{ type: 'interface', id: 'iface-1' }] });
  store.remember({ text: 'Full-clear evidence must start from a fresh save.', kind: 'constraint', bindings: [{ type: 'feature', id: 'feat-1' }] });
  store.remember({ text: 'Task-specific note.', kind: 'note', bindings: [{ type: 'task', id: 'T1' }] });
  store.remember({ text: 'Unrelated interface lesson.', kind: 'lesson', bindings: [{ type: 'interface', id: 'iface-other' }] });
  store.close();

  const artifact = buildTaskContextArtifact({ task: TASK, boundaryContext: null, artifactRoot });
  const texts = artifact.memories.map(m => m.text);
  assert.equal(texts.length, 3);
  assert.ok(texts.some(t => t.includes('audio manifest')));
  assert.ok(texts.some(t => t.includes('fresh save')));
  assert.ok(texts.some(t => t.includes('Task-specific')));
  assert.equal(texts.some(t => t.includes('Unrelated')), false);
  assert.deepEqual(artifact.memories[0].bindings, [{ type: 'interface', id: 'iface-1' }]);
});

test('no memory store yet: nothing injected and no store created as a side effect', () => {
  const { workspace, artifactRoot } = makeWorkspace();
  const artifact = buildTaskContextArtifact({ task: TASK, boundaryContext: null, artifactRoot });
  assert.deepEqual(artifact.memories, []);
  assert.equal(existsSync(join(workspace, '.ariad', 'memory.db')), false);
});

test('injection is capped by count and by serialized size', () => {
  const { workspace, artifactRoot } = makeWorkspace();
  const store = new ProjectMemoryStore(workspace);
  for (let i = 0; i < 12; i += 1) {
    store.remember({
      text: `Lesson ${i}: ${'x'.repeat(300)}`,
      kind: 'lesson',
      bindings: [{ type: 'interface', id: 'iface-1' }],
    });
  }
  store.close();
  const artifact = buildTaskContextArtifact({ task: TASK, boundaryContext: null, artifactRoot });
  assert.ok(artifact.memories.length <= 10, `count cap: got ${artifact.memories.length}`);
  assert.ok(JSON.stringify(artifact.memories).length <= 4096, `byte cap: got ${JSON.stringify(artifact.memories).length}`);
  assert.ok(artifact.memories.length >= 5, 'the cap still admits a useful number of memories');
});

test('project isolation: memories never cross into another project, even for the same interface id', () => {
  const a = makeWorkspace();
  const b = makeWorkspace();
  const storeA = new ProjectMemoryStore(a.workspace);
  storeA.remember({ text: 'Project A secret lesson about iface-1.', kind: 'lesson', bindings: [{ type: 'interface', id: 'iface-1' }] });
  storeA.close();

  const artifactA = buildTaskContextArtifact({ task: TASK, boundaryContext: null, artifactRoot: a.artifactRoot });
  const artifactB = buildTaskContextArtifact({ task: TASK, boundaryContext: null, artifactRoot: b.artifactRoot });

  assert.equal(artifactA.memories.length, 1);
  assert.ok(artifactA.memories[0].text.includes('Project A'));
  assert.deepEqual(artifactB.memories, []);
  assert.equal(existsSync(join(b.workspace, '.ariad', 'memory.db')), false);
});

test('milestone-bound memories are injected via the task owner milestone', () => {
  const { workspace, artifactRoot } = makeWorkspace();
  const store = new ProjectMemoryStore(workspace);
  store.remember({ text: 'Milestone-wide gate rule.', kind: 'constraint', bindings: [{ type: 'milestone', id: 'V2.1' }] });
  store.close();
  const task = { id: 'T9', title: 't', history: [], input: { ownerMilestoneId: 'V2.1' } };
  const artifact = buildTaskContextArtifact({ task, boundaryContext: null, artifactRoot });
  assert.equal(artifact.memories.length, 1);
  assert.ok(artifact.memories[0].text.includes('Milestone-wide'));
});
