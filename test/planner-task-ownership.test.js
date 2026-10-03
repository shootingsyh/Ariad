import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureInterfaceArtifactLayout,
  validateTaskOwnershipCompilation,
} from '../src/v2/interface-contracts.js';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function baseContract(nodeId, nodeType, extra = {}) {
  return {
    version: 1,
    nodeId,
    nodeType,
    decomposition: { kind: 'leaf', reason: 'bounded scope' },
    interfaces: [],
    imports: [],
    integrationScenarios: [],
    featureTasks: [],
    taskLinks: [],
    integrationTasks: [],
    ...extra,
  };
}

test('milestone may link and additively amend a feature task without overriding its base contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-task-ownership-'));
  try {
    const layout = ensureInterfaceArtifactLayout(root);
    write(path.join(layout.featureDir, 'combat.json'), baseContract('combat', 'feature', {
      featureTasks: [{
        id: 'combat-impl',
        title: 'Implement combat',
        intent: 'Implement deterministic combat resolution.',
        acceptanceCriteria: ['Combat resolves according to rules.'],
        testStrategy: 'Unit/component tests for combat resolution.',
        verification: [{ criterionId: 'AC1', mode: 'behavioral', target: 'combat-unit' }],
      }],
    }));

    write(path.join(layout.milestoneDir, 'M1.json'), baseContract('M1', 'milestone', {
      taskLinks: [{
        taskId: 'combat-impl',
        addDependsOn: ['asset-ready'],
        addVerification: [{ criterionId: 'AC1', mode: 'runtime', target: 'milestone-runtime' }],
      }],
      integrationTasks: [{
        id: 'm1-e2e',
        title: 'Verify M1 journey',
        intent: 'Exercise the integrated milestone journey.',
        acceptanceCriteria: ['The supported user journey succeeds end to end.'],
        testStrategy: 'Tester-authored integration/E2E journey.',
        verification: [],
      }],
    }));

    const good = [
      {
        id: 'combat-impl',
        title: 'Implement combat',
        intent: 'Implement deterministic combat resolution.',
        acceptanceCriteria: ['Combat resolves according to rules.'],
        testStrategy: 'Unit/component tests for combat resolution.',
        logicalRefs: ['combat'],
        dependsOn: ['asset-ready'],
        verification: [
          { criterionId: 'AC1', mode: 'behavioral', target: 'combat-unit' },
          { criterionId: 'AC1', mode: 'runtime', target: 'milestone-runtime' },
        ],
      },
      {
        id: 'm1-e2e',
        title: 'Verify M1 journey',
        intent: 'Exercise the integrated milestone journey.',
        acceptanceCriteria: ['The supported user journey succeeds end to end.'],
        testStrategy: 'Tester-authored integration/E2E journey.',
        logicalRefs: ['combat'],
        dependsOn: ['combat-impl'],
        verification: [],
      },
    ];

    assert.equal(validateTaskOwnershipCompilation(root, good).ok, true);

    const overridden = structuredClone(good);
    overridden[0].intent = 'A milestone silently replaced the feature task.';
    assert.throws(
      () => validateTaskOwnershipCompilation(root, overridden),
      /illegally overrode intent/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('milestone taskLink cannot reference a nonexistent feature task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-task-link-'));
  try {
    const layout = ensureInterfaceArtifactLayout(root);
    write(path.join(layout.milestoneDir, 'M1.json'), baseContract('M1', 'milestone', {
      taskLinks: [{
        taskId: 'missing-feature-task',
        addDependsOn: [],
        addVerification: [],
      }],
    }));
    assert.throws(
      () => validateTaskOwnershipCompilation(root, []),
      /references unknown feature task/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
