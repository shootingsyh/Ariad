import { nodePlanningContext, nodePlanningSchedule } from './node-planning-algorithm.js';
import { planningTraversalMachine as machine } from './planning-traversal-machine.js';
import { resolveExecutorSignal } from './executor-dsl.js';
import { readWorkflowExecutorCheckpoint, persistWorkflowExecutorSignal, persistWorkflowSpawn } from './workflow-executor-checkpoint.js';

// Opt-in durable executor. Legacy workflows continue through their existing
// entrypoint until parity tests pass. One state transition per invocation.
export function advanceDurablePlanningWorkflow(store, parent) {
  if (parent.taskKind !== 'WORKFLOW' || parent.executorType !== 'node-planning' || parent.state !== 'READY') return false;
  const state = parent.workflowState ?? { cursor: 0, completedNodes: [], activeChildTaskId: null };
  const checkpoint = readWorkflowExecutorCheckpoint(parent, machine);
  const nodes = parent.input?.nodes;
  const rootId = parent.input?.scopeNodeId ?? parent.input?.rootId;
  if (!Array.isArray(nodes) || !rootId) return false;
  const steps = nodePlanningSchedule({ phase: parent.input.phase, nodes, rootId, operation: parent.input.operation ?? 'REPLAN' });
  const units = steps.filter(step => step.kind === 'planner').map(step => ({
    kind: 'NODE_PLANNING', nodeId: step.nodeId,
    stages: ['tech_lead', 'plan_validator',
      ...(steps.some(x => x.kind === 'parent_critic' && x.nodeId === step.nodeId) ? ['tech_lead_critic'] : [])],
  }));
  units.push({ kind: 'GLOBAL_REVIEW', nodeId: rootId, stages: ['plan_validator', 'tech_lead_critic'] });
  const active = state.activeChildTaskId ? store.getTask(state.activeChildTaskId) : null;
  const childFailed = active && ['NEEDS_HUMAN', 'SYSTEM_BLOCKED', 'OBSOLETE'].includes(active.state);
  switch (checkpoint.state) {
    case 'TRAVERSE': {
      if (state.activeChildTaskId) throw new Error('TRAVERSE_WITH_ACTIVE_CHILD');
      const signal = state.cursor >= units.length ? 'EXHAUSTED' : 'NODE_FOUND';
      persistWorkflowExecutorSignal({ store, taskId: parent.id, machine, signal });
      return true;
    }
    case 'SPAWN': {
      if (state.activeChildTaskId) throw new Error('SPAWN_WITH_ACTIVE_CHILD');
      const index = state.cursor;
      const unit = units[index];
      if (!unit) throw new Error('WORKFLOW_SPAWN_CURSOR_OUT_OF_RANGE');
      const childId = `${parent.id}:${index}`;
      const child = {
        id: childId, projectId: parent.projectId, scope: 'control', flowId: parent.flowId,
        parentTaskId: parent.id, taskKind: unit.kind, stage: unit.stages[0],
        input: { purpose: 'NODE_PLANNING_WORKFLOW', phase: parent.input.phase, nodeId: unit.nodeId,
          stages: unit.stages, reason: parent.input.reason, nodes, rootId,
          planningContext: nodePlanningContext({ phase: parent.input.phase,
            operation: parent.input.operation ?? 'REPLAN', nodes, nodeId: unit.nodeId }) },
      };
      persistWorkflowSpawn({ store, taskId: parent.id, machine, childTask: child,
        workflowState: { cursor: index + 1, activeChildTaskId: childId } });
      return true;
    }
    case 'WAIT_CHILD': {
      if (!state.activeChildTaskId || !active) throw new Error('WORKFLOW_CHILD_MISSING');
      if (childFailed) {
        // Preserve existing externally visible NEEDS_HUMAN state.
        const nextState = resolveExecutorSignal(machine, checkpoint.state, 'CHILD_FAILED');
        store.updateTask(parent.id, parent.version, {
          state: 'NEEDS_HUMAN',
          workflowState: { ...state, blockedChildTaskId: active.id,
            executor: { machineId: machine.id, machineVersion: machine.version, state: nextState } },
        });
        return true;
      }
      if (active.state !== 'DONE') return false;
      const completedNodes = state.completedNodes?.includes(active.id)
        ? state.completedNodes : [...(state.completedNodes ?? []), active.id];
      // Atomic cursor release and state advance in a single task version update.
      const updated = store.getTask(parent.id);
      const nextState = resolveExecutorSignal(machine, checkpoint.state, 'CHILD_COMPLETE');
      const next = { ...(updated.workflowState ?? {}), completedNodes,
        activeChildTaskId: null,
        executor: { machineId: machine.id, machineVersion: machine.version, state: nextState } };
      store.updateTask(updated.id, updated.version, { workflowState: next });
      return true;
    }
    case 'COMPLETE':
      store.updateTask(parent.id, parent.version, { state: 'DONE',
        workflowState: { ...state, activeChildTaskId: null } });
      return true;
    case 'FAILED':
      store.updateTask(parent.id, parent.version, { state: 'NEEDS_HUMAN' });
      return true;
    default:
      throw new Error(`unknown planning executor state: ${checkpoint.state}`);
  }
}
