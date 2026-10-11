import { nodePlanningSchedule, nodePlanningContext, resolvePlanningGate } from './node-planning-algorithm.js';

// Isolated executor for fake-provider E2E and future scheduler integration.
// Only the injected provider can generate artifacts; all gate ordering is deterministic.
export async function runNodePlanning({ phase, nodes, rootId, operation = 'REPLAN', projectBrief = null,
  featureManifest = [], provider, checkpoint = null }) {
  if (typeof provider !== 'function') throw new Error('provider is required');
  const schedule = nodePlanningSchedule({ phase, nodes, rootId, operation });
  const records = checkpoint?.records ? structuredClone(checkpoint.records) : [];
  let cursor = checkpoint?.cursor ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > schedule.length) throw new Error('invalid checkpoint cursor');
  const attempts = {};
  for (const record of records) if (record.action === 'RETRY_NODE') {
    const key = `${record.step.kind}:${record.step.nodeId}`;
    attempts[key] = Math.max(attempts[key] ?? 0, record.nextAttempt);
  }
  while (cursor < schedule.length) {
    const step = schedule[cursor];
    const context = step.kind === 'planner'
      ? nodePlanningContext({ phase, operation, nodes, nodeId: step.nodeId, projectBrief, featureManifest })
      : { phase, nodeId: step.nodeId, gate: step.kind };
    const result = await provider({ step: structuredClone(step), context });
    if (!result || typeof result.passed !== 'boolean') throw new Error('provider must return {passed:boolean}');
    if (step.kind === 'planner') {
      if (!result.passed) throw new Error(`planner failed at ${step.nodeId}`);
      records.push({ step, action: 'ADVANCE' });
      cursor += 1;
      continue;
    }
    const key = `${step.kind}:${step.nodeId}`;
    const decision = resolvePlanningGate({ kind: step.kind, passed: result.passed, attempts: attempts[key] ?? 0 });
    records.push({ step, ...decision });
    if (decision.action === 'ADVANCE') { cursor += 1; continue; }
    if (decision.action === 'RETRY_NODE') {
      attempts[key] = decision.nextAttempt;
      // Retry planner of the same node, not the whole tree.
      cursor = schedule.findIndex(item => item.kind === 'planner' && item.nodeId === step.nodeId);
      continue;
    }
    return { status: decision.action, cursor, records, checkpoint: { cursor, records } };
  }
  return { status: 'PASS', cursor, records, checkpoint: { cursor, records } };
}
