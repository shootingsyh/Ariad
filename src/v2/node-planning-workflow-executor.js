import { nodePlanningContext, nodePlanningSchedule } from './node-planning-algorithm.js';

const finished = task => task && task.state === 'DONE';

// All state is durable in v2_tasks. Each tick is safe to repeat after a crash.
export function advanceNodePlanningWorkflows(store, projectId) {
  const parents = store.listTasks(projectId, { scope: 'control' }).filter(task => task.taskKind === 'WORKFLOW' && task.executorType === 'node-planning' && task.state === 'READY');
  for (const parent of parents) {
    const state = parent.workflowState ?? { cursor: 0, completedNodes: [], activeChildTaskId: null };
    const nodes = parent.input?.nodes;
    const rootId = parent.input?.scopeNodeId ?? parent.input?.rootId;
    // Never guess a plan: the TL must provide a validated tree before execution.
    if (!Array.isArray(nodes) || !rootId) continue;
    const steps = nodePlanningSchedule({ phase: parent.input.phase, nodes, rootId, operation: parent.input.operation ?? 'REPLAN' });
    const units = [];
    for (const step of steps) {
      if (step.kind === 'planner') units.push({ kind: 'NODE_PLANNING', nodeId: step.nodeId, stages: ['tech_lead', 'plan_validator', ...(steps.some(x => x.kind === 'parent_critic' && x.nodeId === step.nodeId) ? ['tech_lead_critic'] : [])] });
    }
    units.push({ kind: 'GLOBAL_REVIEW', nodeId: rootId, stages: ['plan_validator', 'tech_lead_critic'] });
    const active = state.activeChildTaskId && store.getTask(state.activeChildTaskId);
    if (state.activeChildTaskId && active?.state === 'NEEDS_HUMAN') {
      store.updateTask(parent.id, parent.version, { state: 'NEEDS_HUMAN', workflowState: { ...state, blockedChildTaskId: active.id } });
      continue;
    }
    if (state.activeChildTaskId && !finished(active)) continue;
    const completed = active && !state.completedNodes.includes(active.id) ? [...state.completedNodes, active.id] : state.completedNodes;
    const index = state.cursor;
    if (index >= units.length) {
      store.updateTask(parent.id, parent.version, { state: 'DONE', workflowState: { ...state, activeChildTaskId: null, completedNodes: completed } });
      continue;
    }
    const unit = units[index];
    const childId = `${parent.id}:${index}`;
    const child = {
      id: childId, projectId, scope: 'control', flowId: parent.flowId,
      parentTaskId: parent.id, taskKind: unit.kind, stage: unit.stages[0],
      input: { purpose: 'NODE_PLANNING_WORKFLOW', phase: parent.input.phase, nodeId: unit.nodeId, stages: unit.stages, reason: parent.input.reason, nodes, rootId, planningContext: nodePlanningContext({ phase: parent.input.phase, operation: parent.input.operation ?? 'REPLAN', nodes, nodeId: unit.nodeId }) },
    };
    store.advanceNodePlanningWorkflow({ parentTaskId: parent.id, expectedVersion: parent.version,
      childTask: child, workflowState: { cursor: index + 1, activeChildTaskId: childId, completedNodes: completed } });
  }
}

export function workflowChildTransition(task, result) {
  if (!['NODE_PLANNING', 'GLOBAL_REVIEW'].includes(task.taskKind)) return null;
  if (task.stage === 'project_debugger') {
    const guidance = result.result?.guidance;
    if (result.outcome === 'RETRY_WITH_GUIDANCE' && typeof guidance === 'string' && guidance.trim() && (task.input?.debuggerRecoveryCount ?? 0) < 1) {
      return { state: 'READY', stage: 'tech_lead', input: { ...task.input, workflowRetries: task.taskKind === 'GLOBAL_REVIEW' ? 1 : 0, debuggerRecoveryCount: 1, previousGateFailure: { ...task.input.previousGateFailure, debuggerGuidance: guidance.trim() } }, transitionHistory: { type: 'WORKFLOW_DEBUGGER_RECOVERY', at: new Date().toISOString() } };
    }
    return { state: 'NEEDS_HUMAN', transitionHistory: { type: 'WORKFLOW_DEBUGGER_DIAGNOSIS', outcome: result.outcome, guidance: guidance ?? result.summary ?? null, at: new Date().toISOString() } };
  }
  const stages = task.input?.stages ?? [];
  const index = stages.indexOf(task.stage);
  if (index < 0 && !(task.taskKind === 'GLOBAL_REVIEW' && task.stage === 'tech_lead' && (task.input?.workflowRetries ?? 0) > 0)) throw new Error('WORKFLOW_STAGE_MISMATCH');
  const allowed = task.stage === 'tech_lead' ? ['PLANNED', 'REPLANNED'] : task.stage === 'tech_lead_critic' ? ['CLEAN', 'MINOR_ONLY'] : ['PASS'];
  const passed = allowed.includes(result.outcome);
  if (!passed) {
    const retries = task.input?.workflowRetries ?? 0;
    if (retries < 2) return { state: 'READY', stage: 'tech_lead', input: { ...task.input, workflowRetries: retries + 1, previousGateFailure: { stage: task.stage, outcome: result.outcome, details: result.result ?? null } } };
    return { state: 'READY', stage: 'project_debugger', input: { ...task.input, previousGateFailure: { stage: task.stage, outcome: result.outcome, details: result.result ?? null } }, transitionHistory: { type: 'WORKFLOW_DEBUGGER_ROUTED', attempts: retries, at: new Date().toISOString() } };
  }
  if (task.taskKind === 'GLOBAL_REVIEW' && task.stage === 'tech_lead') return { state: 'READY', stage: 'plan_validator' };
  return index + 1 < stages.length ? { state: 'READY', stage: stages[index + 1] } : { state: 'DONE' };
}
