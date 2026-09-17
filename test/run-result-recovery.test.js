import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeRegistry } from '../src/runtime-registry.js';
import { createFakeRuntimeAdapter } from '../src/adapters/fake-runtime.js';
import { RuntimeExecutor } from '../src/runtime-executor.js';
import { SQLiteRunStore } from '../src/sqlite-run-store.js';
import { SQLiteWorkflowStateStore } from '../src/sqlite-workflow-state-store.js';
import { TransitionEngine } from '../src/transition-engine.js';
import { WorkflowTransitionService } from '../src/workflow-transition-service.js';
import { recoverCompletedRunResults } from '../src/run-result-recovery.js';

test('completed Run survives crash before workflow transition and is applied exactly once by durable cursor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-run-result-'));
  const dbFile = join(dir, 'state.db');
  let runs;
  let workflow;
  try {
    runs = new SQLiteRunStore(dbFile);
    workflow = new SQLiteWorkflowStateStore(dbFile);
    workflow.create('T1');

    const registry = new RuntimeRegistry();
    registry.register('engineering', createFakeRuntimeAdapter({ script: [{ outcome: 'IMPLEMENTATION_READY', result: { artifact: 'x' } }] }));
    const executor = new RuntimeExecutor({ registry, runStore: runs, roleRuntimeMap: { developer: 'engineering' } });

    const result = await executor.run('developer', { taskId: 'T1', devCycle: 1, strategyEpoch: 1 });
    assert.equal(result.executionStatus, 'COMPLETED');
    assert.equal(workflow.get('T1').stage, 'developer', 'simulate crash before transition is applied');
    assert.equal(runs.list().length, 1);

    runs.close();
    workflow.close();

    runs = new SQLiteRunStore(dbFile);
    workflow = new SQLiteWorkflowStateStore(dbFile);
    const transitions = new WorkflowTransitionService({ store: workflow, engine: new TransitionEngine() });

    const first = await recoverCompletedRunResults({ runStore: runs, stateStore: workflow, transitionService: transitions });
    assert.equal(first.length, 1);
    assert.equal(workflow.get('T1').stage, 'tester');
    assert.equal(workflow.get('T1').devCycle, 1);
    assert.equal(runs.list().length, 1, 'recovery must not create a second Run');

    const versionAfterFirst = workflow.get('T1').version;
    const second = await recoverCompletedRunResults({ runStore: runs, stateStore: workflow, transitionService: transitions });
    assert.equal(second.length, 0, 'durable cursor makes already-applied completed Run stale');
    assert.equal(workflow.get('T1').version, versionAfterFirst);
    assert.equal(runs.list().length, 1);
  } finally {
    try { runs?.close(); } catch {}
    try { workflow?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
