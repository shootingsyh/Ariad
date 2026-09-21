import http from 'node:http';

const port = Number(process.env.ARIAD_FAKE_PROVIDER_PORT || 18081);

function requestText(request) {
  return (request.messages ?? []).map((message) => {
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content)) return message.content.map((part) => part?.text ?? '').join(' ');
    return '';
  }).join('\n');
}

function requestRole(request) {
  const text = requestText(request);
  if (/Ariad's Tech Lead/i.test(text) || /Tech Lead dependency pass/i.test(text) || /Tech Lead repair pass/i.test(text)) return 'tech_lead';
  if (/delivery-plan critic/i.test(text)) return 'tech_lead_critic';
  if (/PM reviewing a validated delivery plan/i.test(text)) return 'pm';
  return text.match(/Ariad(?:'s| the)?\s+(developer|tester|reviewer|project_debugger|tech_lead|pm|system_debugger|artist)\s+role/i)?.[1]?.toLowerCase() ?? null;
}

function requestCycle(request) {
  return Number(requestText(request).match(/"devCycle":(\d+)/)?.[1] ?? 0);
}

function requestTaskId(request) {
  return requestText(request).match(/"taskId":"([^"]+)"/)?.[1] ?? null;
}

function hasWorkspace(request) {
  return /"workspace":"[^"]+"/.test(requestText(request));
}

function hasToolResult(request) {
  return (request.messages ?? []).some((message) => message?.role === 'tool');
}

const roleResultTools = {
  artist: 'ariad_artist_result',
  developer: 'ariad_developer_result',
  tester: 'ariad_tester_result',
  reviewer: 'ariad_reviewer_result',
  project_debugger: 'ariad_project_debugger_result',
  tech_lead: 'ariad_tech_lead_result',
  tech_lead_critic: 'ariad_tech_lead_critic_result',
  pm: 'ariad_pm_result',
};

function requestToolNames(request) {
  return new Set((request.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean));
}

function hasCalledTool(request, name) {
  return (request.messages ?? []).some((message) =>
    (message?.tool_calls ?? []).some((call) => call?.function?.name === name)
  );
}

function requestAttemptId(request) {
  const text = requestText(request);
  return text.match(/Pass the exact Ariad attemptId from ARIAD RUNTIME CONTEXT:\s*([^\n]+)/i)?.[1]?.trim()
    ?? text.match(/"attemptId"\s*:\s*"([^"]+)"/)?.[1]
    ?? null;
}

function roleResultToolCall(request) {
  const role = requestRole(request);
  const name = roleResultTools[role];
  if (!name || !requestToolNames(request).has(name) || hasCalledTool(request, name)) return null;

  const taskId = requestTaskId(request);
  const cycle = requestCycle(request);
  const hasPriorToolWork = hasToolResult(request);
  const artifact = plannerArtifactTransport(request);
  const canSubmitWithoutWorkTool = ['tech_lead', 'tech_lead_critic', 'pm'].includes(role)
    && !(role === 'tech_lead' && artifact);
  if (!hasPriorToolWork && !canSubmitWithoutWorkTool) return null;

  let outcome = 'PASS';
  if (role === 'tech_lead') outcome = 'PLANNED';
  else if (role === 'tech_lead_critic') outcome = 'CLEAN';
  else if (role === 'pm') outcome = 'PLAN_ACCEPTED';
  else if (role === 'reviewer' && taskId === 'T1' && cycle === 1) outcome = 'NOT_PASS';

  let result = { source: 'fake-provider', cycle, taskId };
  if (role === 'tech_lead' && isV2PlanningPrompt(request)) result = fakeV2Plan();
  if (role === 'tech_lead_critic') result = { issues: [], summary: 'No substantive issues.' };
  if (role === 'pm') result = { reason: 'Plan covers the requested outcome.', startDelivery: true, guidance: '', questions: [] };

  return {
    name,
    arguments: {
      attemptId: requestAttemptId(request),
      outcome,
      summary: `${role} submitted structured result`,
      keyPoints: [],
      artifacts: [],
      result,
    },
  };
}

function plannerArtifactTransport(request) {
  const text = requestText(request);
  const path = text.match(/exact file path using the file write tool:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const ref = text.match(/"artifactRef":"([^"]+)"/)?.[1] ?? null;
  return path && ref ? { path, ref } : null;
}

function isDiscovery(request) {
  return requestRole(request) === 'tech_lead' && /"planningPhase":"EXISTING_PROJECT_DISCOVERY"/.test(requestText(request));
}

function isCurrentStateReview(request) {
  return requestRole(request) === 'pm' && /"productPhase":"CURRENT_STATE_REVIEW"/.test(requestText(request));
}

function isProjectExecutionRole(request) {
  const role = requestRole(request);
  return requestTaskId(request) === 'T1' && ['developer', 'tester', 'reviewer'].includes(role);
}

function toolCallFor(request) {
  const roleResult = roleResultToolCall(request);
  if (roleResult) return roleResult;
  if (hasToolResult(request)) return null;
  const artifact = plannerArtifactTransport(request);
  if (artifact) {
    return {
      name: 'write',
      arguments: {
        path: artifact.path,
        content: JSON.stringify(fakeV2Plan(), null, 2),
      },
    };
  }
  if (!hasWorkspace(request)) return null;
  const role = requestRole(request);
  const cycle = requestCycle(request);
  if (isDiscovery(request)) return { name: 'read', arguments: { path: 'README.md' } };
  if (requestTaskId(request) !== 'T1') return null;
  if (role === 'developer') {
    return {
      name: 'write',
      arguments: {
        path: 'health.txt',
        content: cycle === 1 ? 'status=needs-review\ncycle=1\n' : 'status=healthy\ncycle=2\n',
      },
    };
  }
  if (role === 'tester' || role === 'reviewer') return { name: 'read', arguments: { path: 'health.txt' } };
  return null;
}

function fakeProjectModel({ existingProject }) {
  const tasks = [
    { id: 'T_INTERFACE', title: 'Interface', kind: 'CONTRACT_INTERFACE', componentId: 'health-feature', verticalSliceId: 'health-slice', acceptanceCriteria: ['matches contract'], testStrategy: 'load interface', atomic: true, dependsOn: [] },
    { id: 'T_CONTRACT_TEST', title: 'Contract test', kind: 'CONTRACT_TEST', componentId: 'health-feature', verticalSliceId: 'health-slice', acceptanceCriteria: ['detect violation'], testStrategy: 'run contract test', atomic: true, dependsOn: ['T_INTERFACE'] },
    { id: 'T_FAKE', title: 'Fake provider', kind: 'FAKE_PROVIDER', componentId: 'health-feature', verticalSliceId: 'health-slice', acceptanceCriteria: ['conforms'], testStrategy: 'run contract test', atomic: true, dependsOn: ['T_CONTRACT_TEST'] },
    { id: 'T1', title: 'Skeleton', kind: 'VERTICAL_SKELETON', componentId: 'health-feature', verticalSliceId: 'health-slice', acceptanceCriteria: ['health.txt status=healthy'], testStrategy: 'read health.txt', atomic: true, dependsOn: ['T_FAKE'] },
  ];
  return {
    transportProbe: 'x'.repeat(5000),
    currentState: { existingProject, summary: existingProject ? 'Existing project' : 'Greenfield', keyFiles: existingProject ? ['README.md'] : [], knownConstraints: [] },
    architecture: {
      horizontals: [{ id: 'runtime', name: 'Runtime', responsibility: 'app shell' }],
      verticals: [{ id: 'health-feature', name: 'Health', responsibility: 'health state' }],
    },
    contracts: [{
      id: 'health-contract', provider: 'health-feature', consumers: ['runtime'], purpose: 'health state', interface: 'health.txt status/cycle', testBoundary: 'read health.txt', maturity: 'PROVISIONAL', justifiedByVerticals: ['health-slice'], interfaceTaskId: 'T_INTERFACE', contractTestTaskId: 'T_CONTRACT_TEST', fakeTaskId: 'T_FAKE',
    }],
    dependencies: [{ from: 'runtime', to: 'health-feature', contractId: 'health-contract', implementationRequired: false, rationale: 'fake sufficient' }],
    verticalSlices: [{ id: 'health-slice', name: 'Health slice', goal: 'health end to end', componentIds: ['runtime', 'health-feature'], contractIds: ['health-contract'], skeletonTest: 'read health.txt', skeletonTaskId: 'T1', taskIds: tasks.map((task) => task.id) }],
    technicalDirection: { summary: 'Node file fixture', foundations: ['Node.js'], languages: [{ scope: 'app', language: 'JavaScript', rationale: 'existing stack' }], decisions: [] },
    decomposition: {
      nodes: [
        { id: 'runtime', parentId: null, kind: 'component', componentId: 'runtime', children: [], taskId: null },
        { id: 'health-feature', parentId: null, kind: 'component', componentId: 'health-feature', children: tasks.map((task) => `${task.id}-node`), taskId: null },
        ...tasks.map((task) => ({ id: `${task.id}-node`, parentId: 'health-feature', kind: 'task', componentId: 'health-feature', children: [], taskId: task.id })),
      ],
    },
    tasks,
  };
}


function fakeV2Plan() {
  return {
    version: 2,
    projectSummary: 'Tiny health project',
    rootTaskId: 'ROOT',
    tasks: [
      {
        id: 'ROOT',
        title: 'Health project complete',
        intent: 'Integrate and verify the complete health project.',
        parentId: null,
        dependsOn: [],
        acceptanceCriteria: ['The health project is complete.'],
        testStrategy: 'Run final integration verification.',
      },
      {
        id: 'T1',
        title: 'Health endpoint fixture',
        intent: 'Create health.txt with a healthy status.',
        parentId: 'ROOT',
        dependsOn: [],
        acceptanceCriteria: ['health.txt status=healthy'],
        testStrategy: 'Read health.txt.',
      },
    ],
    milestones: [
      {
        id: 'M1',
        title: 'Healthy endpoint usable',
        goal: 'The health endpoint fixture works as an integrated slice.',
        parentId: null,
        dependsOn: [],
        logicalTaskIds: ['T1'],
        acceptanceCriteria: ['The health slice is usable.'],
        testStrategy: 'Read health.txt after T1 passes its normal test/review flow.',
      },
    ],
  };
}

function isV2PlanningPrompt(request) {
  const text = requestText(request);
  return /delivery tree|dependency pass|repair pass|PLANNER ARTIFACT TRANSPORT/i.test(text)
    && (/"version"\s*:\s*\{\s*"const"\s*:\s*2/.test(text) || /PLANNER ARTIFACT TRANSPORT/i.test(text));
}

function isV2CriticPrompt(request) {
  return /delivery-plan critic/i.test(requestText(request));
}

function isV2PmPrompt(request) {
  return /PM reviewing a validated delivery plan/i.test(requestText(request));
}

function logRoleResultToolResponse(request) {
  const role = requestRole(request);
  const name = roleResultTools[role];
  if (!name || !hasCalledTool(request, name)) return;
  const toolMessages = (request.messages ?? []).filter(message => message?.role === 'tool');
  const latest = toolMessages.at(-1);
  if (latest) {
    console.log(`ARIAD_FAKE_ROLE_TOOL_RESULT role=${role} tool=${name} content=${JSON.stringify(latest.content)}`);
  }
}

function roleReply(request) {
  logRoleResultToolResponse(request);
  const cycle = requestCycle(request);
  const role = requestRole(request);
  const taskId = requestTaskId(request);

  if (isV2PlanningPrompt(request)) {
    const artifact = plannerArtifactTransport(request);
    if (artifact) {
      if (!hasToolResult(request)) {
        return { executionStatus: 'FAILED', failure: 'FAKE_E2E_PLANNER_ARTIFACT_NOT_WRITTEN' };
      }
      return {
        executionStatus: 'COMPLETED',
        outcome: 'PLANNED',
        result: { artifactRef: artifact.ref, summary: 'v2 delivery plan written' },
      };
    }
    return { executionStatus: 'COMPLETED', outcome: 'PLANNED', result: fakeV2Plan() };
  }
  if (isV2CriticPrompt(request)) {
    return { executionStatus: 'COMPLETED', outcome: 'CLEAN', result: { issues: [], summary: 'No substantive issues.' } };
  }
  if (isV2PmPrompt(request)) {
    return { executionStatus: 'COMPLETED', outcome: 'PLAN_ACCEPTED', result: { reason: 'Plan covers the requested outcome.', startDelivery: true, guidance: '', questions: [] } };
  }

  if (isDiscovery(request) && (!hasWorkspace(request) || !hasToolResult(request))) {
    return { executionStatus: 'FAILED', failure: !hasWorkspace(request) ? 'FAKE_E2E_WORKSPACE_MISSING' : 'FAKE_E2E_DISCOVERY_TOOL_RESULT_MISSING' };
  }
  if (isProjectExecutionRole(request) && (!hasWorkspace(request) || !hasToolResult(request))) {
    return { executionStatus: 'FAILED', failure: !hasWorkspace(request) ? 'FAKE_E2E_WORKSPACE_MISSING' : 'FAKE_E2E_TOOL_RESULT_MISSING' };
  }

  if (role === 'tech_lead') {
    const existingProject = isDiscovery(request) || /"existingProject":true/.test(requestText(request));
    return { executionStatus: 'COMPLETED', outcome: 'PLANNED', result: { source: 'fake-provider', projectModel: fakeProjectModel({ existingProject }) } };
  }
  if (role === 'pm') {
    return {
      executionStatus: 'COMPLETED',
      outcome: isCurrentStateReview(request) ? 'CURRENT_STATE_ACKNOWLEDGED' : 'PLAN_ACCEPTED',
      result: { source: 'fake-provider', reason: 'plan covers requested outcome', startDelivery: true, guidance: '', customerOutcomeSummary: 'TL design is materialized into tasks.', questions: [] },
    };
  }
  if (role === 'artist') return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle, taskId } };
  if (role === 'developer') return { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTATION_READY', result: { source: 'fake-provider', cycle, taskId, toolExecuted: hasToolResult(request) } };
  if (role === 'tester') return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle, taskId, toolExecuted: hasToolResult(request) } };
  if (role === 'reviewer' && taskId === 'T1' && cycle === 1) return { executionStatus: 'COMPLETED', outcome: 'NOT_PASS', result: { source: 'fake-provider', cycle, taskId, toolExecuted: hasToolResult(request), findings: ['needs semantic fix'] } };
  if (role === 'reviewer') return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle, taskId, toolExecuted: hasToolResult(request) } };
  return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider' } };
}

function json(res, value) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function streamChunk(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    json(res, {
      object: 'list',
      data: [
        { id: 'default', object: 'model', owned_by: 'ariad-ci' },
        { id: 'role', object: 'model', owned_by: 'ariad-ci' },
      ],
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body || '{}');
    console.log(`ARIAD_FAKE_MODEL model=${request.model ?? 'unknown'} role=${requestRole(request) ?? 'unknown'}`);
    const toolCall = toolCallFor(request);
    const id = `chatcmpl-${Date.now()}`;

    if (toolCall) {
      const callId = `call-${requestRole(request)}-${requestCycle(request)}-${Date.now()}`;
      console.log(`ARIAD_FAKE_TOOL_CALL role=${requestRole(request)} cycle=${requestCycle(request)} tool=${toolCall.name}`);
      const call = { index: 0, id: callId, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] });
        streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      json(res, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      return;
    }

    const role = requestRole(request);
    const resultToolName = roleResultTools[role];
    const reply = resultToolName && hasCalledTool(request, resultToolName)
      ? '结构化结果已经通过 Ariad result tool 提交；这段自然语言只是结束语。'
      : JSON.stringify(roleReply(request));
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] });
      streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
      res.end('data: [DONE]\n\n');
      return;
    }
    json(res, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => console.log(`ARIAD_FAKE_PROVIDER_READY ${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
