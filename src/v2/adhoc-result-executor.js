import { effectiveTaskKind, TASK_KINDS } from './control-task-policy.js';
import { executorTransitionFromResult } from './role-executor-transition.js';

// Ad-hoc analysis is read-only and has no delivery or planning side effects.
// Its completion is decided from the recorded role result, not role.transition().
const SUCCESS = new Set(['PLANNED', 'REPLANNED', 'PASS', 'COMPLETE']);
export function adhocResultTransition(task, result) {
  if (effectiveTaskKind(task) !== TASK_KINDS.ADHOC_ANALYSIS) return null;
  if (task.stage !== 'tech_lead') throw new Error('ADHOC_ANALYSIS_REQUIRES_TECH_LEAD');
  const outcome = result?.outcome;
  const signal = SUCCESS.has(outcome) ? 'COMPLETE' : 'NEEDS_HUMAN';
  const transition = executorTransitionFromResult(task, signal);
  return {
    ...transition.patch,
    ...(signal === 'NEEDS_HUMAN' ? {
      transitionHistory: {
        type: 'ADHOC_ANALYSIS_REJECTED',
        outcome: outcome ?? null,
        at: new Date().toISOString(),
      },
    } : {}),
  };
}
