function compactHistory(history = []) {
  const takeoverNotes = history
    .filter(entry => entry?.type === 'TAKEOVER_NOTE')
    .slice(-4)
    .map(entry => ({
      type: entry.type,
      summary: entry.summary ?? entry.note ?? null,
      guidance: entry.guidance ?? null,
      files: entry.files ?? null,
    }));

  const roleResults = history
    .filter(entry => entry?.type === 'ROLE_RESULT')
    .slice(-5)
    .map(entry => ({
      role: entry.role,
      outcome: entry.outcome,
      summary: entry.summary ?? null,
      keyPoints: entry.keyPoints ?? [],
      executionContext: entry.executionContext ?? null,
    }));

  const interruptions = history
    .filter(entry => entry?.type === 'SYSTEM_INTERRUPTION')
    .slice(-3)
    .map(entry => ({
      role: entry.role,
      failure: entry.failure ?? null,
      executionContext: entry.executionContext ?? null,
    }));

  const routing = history
    .filter(entry => [
      'DEBUGGER_ROUTE',
      'PRODUCT_DECISION',
      'PLANNER_VALIDATION_ESCALATION',
      'SYSTEM_RECOVERY',
    ].includes(entry?.type))
    .slice(-4)
    .map(entry => ({
      type: entry.type,
      summary: entry.summary ?? null,
      guidance: entry.guidance ?? null,
      targetStage: entry.targetStage ?? null,
    }));

  return { takeoverNotes, roleResults, interruptions, routing };
}

function unique(items, limit) {
  return [...new Set(items.filter(Boolean))].slice(-limit);
}

export function deriveExecutionHandoff(history = []) {
  const contexts = history
    .map(entry => entry?.executionContext)
    .filter(Boolean)
    .slice(-4);

  const confirmedFiles = unique(
    contexts.flatMap(ctx => ctx.readFiles ?? []),
    24,
  );
  const modifiedFiles = unique(
    contexts.flatMap(ctx => ctx.writtenFiles ?? []),
    16,
  );
  const commands = contexts
    .flatMap(ctx => ctx.commands ?? [])
    .slice(-10)
    .map(item => typeof item === 'string'
      ? { command: item }
      : {
          command: item.command ?? null,
          exitCode: item.exitCode ?? null,
        });

  if (confirmedFiles.length === 0 && modifiedFiles.length === 0 && commands.length === 0) {
    return null;
  }

  return {
    confirmedFiles,
    modifiedFiles,
    recentCommands: commands,
  };
}

export function buildStandaloneRolePrompt(context = {}, fallbackPrompt = '') {
  const task = context.task ?? {};
  const history = task.history ?? [];
  const historySummary = compactHistory(history);
  const executionHandoff = context.executionHandoff ?? deriveExecutionHandoff(history);

  const taskPayload = {
    id: task.id ?? null,
    title: task.title ?? null,
    intent: task.intent ?? null,
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    acceptanceCriterionIds: task.acceptanceCriterionIds ?? [],
    verification: task.verification ?? [],
    testStrategy: task.testStrategy ?? null,
    art: task.art ?? null,
    devCycle: context.devCycle ?? null,
    strategyEpoch: context.strategyEpoch ?? null,
  };

  const sections = [
    context.v2Prompt || fallbackPrompt || '',
    '',
    'ASSIGNED TASK',
    JSON.stringify(taskPayload, null, 2),
  ];

  const hasHistory = Object.values(historySummary).some(items => items.length > 0);
  if (hasHistory) {
    sections.push(
      '',
      'RELEVANT PRIOR TASK HISTORY',
      JSON.stringify(historySummary, null, 2),
    );
  }

  if (executionHandoff) {
    sections.push(
      '',
      'ARIAD EXECUTION HANDOFF',
      'These are concrete anchors observed by previous attempts. Start from them instead of repeating repository-wide discovery. Re-read only what is needed to verify current state. Expand beyond these anchors only when new evidence requires it.',
      JSON.stringify(executionHandoff, null, 2),
    );
  }

  sections.push(
    '',
    'EXECUTION DISCIPLINE',
    'Do not perform broad repository exploration after the implementation path is already identified. Prefer targeted search/read of the named files and functions, make the smallest implementation change, then run focused verification. If you discover a better concrete path, use it and leave the new anchors in your structured result/context.',
  );

  return sections.filter(part => part !== '').join('\n\n');
}
