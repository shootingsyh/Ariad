export async function recoverCompletedRunResults({ runStore, stateStore, transitionService }) {
  if (!runStore || typeof runStore.list !== 'function') throw new Error('runStore.list is required');
  if (!stateStore || typeof stateStore.get !== 'function') throw new Error('stateStore.get is required');
  if (!transitionService || typeof transitionService.apply !== 'function') throw new Error('transitionService.apply is required');

  const recovered = [];
  for (const run of runStore.list()) {
    if (run.state !== 'COMPLETED') continue;
    const state = stateStore.get(run.taskId);
    if (!state || state.status !== 'RUNNING') continue;
    if (state.stage !== run.role) continue;
    if ((run.context?.devCycle ?? state.devCycle) !== state.devCycle) continue;
    if ((run.context?.strategyEpoch ?? state.strategyEpoch) !== state.strategyEpoch) continue;

    const envelope = run.result ?? {};
    const transition = await transitionService.apply(
      {
        taskId: run.taskId,
        role: run.role,
        context: run.context ?? {},
      },
      {
        executionStatus: 'COMPLETED',
        outcome: envelope.outcome ?? null,
        result: envelope.result ?? null,
        runId: run.id,
      },
    );
    recovered.push({ runId: run.id, taskId: run.taskId, transition });
  }
  return recovered;
}
