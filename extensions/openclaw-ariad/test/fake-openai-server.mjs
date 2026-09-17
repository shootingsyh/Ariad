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
  return requestText(request).match(/Ariad(?:'s| the)?\s+(developer|tester|reviewer|project_debugger|tech_lead|pm|system_debugger|artist)\s+role/i)?.[1]?.toLowerCase() ?? null;
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

function isDiscovery(request) {
  return requestRole(request) === 'tech_lead' && /"planningPhase":"EXISTING_PROJECT_DISCOVERY"/.test(requestText(request));
}

function isRequirementPlan(request) {
  return requestRole(request) === 'tech_lead' && /"planningPhase":"REQUIREMENT_PLAN"/.test(requestText(request));
}

function isCurrentStateReview(request) {
  return requestRole(request) === 'pm' && /"productPhase":"CURRENT_STATE_REVIEW"/.test(requestText(request));
}

function isProjectExecutionRole(request) {
  const role = requestRole(request);
  return requestTaskId(request) === 'T1' && ['developer', 'tester', 'reviewer'].includes(role);
}

function toolCallFor(request) {
  if (!hasWorkspace(request) || hasToolResult(request)) return null;
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
    {
      id: 'T_INTERFACE',
      title: 'Implement the health contract interface',
      kind: 'CONTRACT_INTERFACE',
      componentId: 'health-feature',
      verticalSliceId: 'health-slice',
      acceptanceCriteria: ['The executable interface matches the TL-designed health contract'],
      testStrategy: 'Load the interface and verify the declared health boundary',
      atomic: true,
      dependsOn: [],
    },
    {
      id: 'T_CONTRACT_TEST',
      title: 'Implement executable health contract tests',
      kind: 'CONTRACT_TEST',
      componentId: 'health-feature',
      verticalSliceId: 'health-slice',
      acceptanceCriteria: ['The contract suite detects a violating provider'],
      testStrategy: 'Run the contract suite against deterministic fixtures',
      atomic: true,
      dependsOn: ['T_INTERFACE'],
    },
    {
      id: 'T_FAKE',
      title: 'Implement minimal fake health provider',
      kind: 'FAKE_PROVIDER',
      componentId: 'health-feature',
      verticalSliceId: 'health-slice',
      acceptanceCriteria: ['The fake provider conforms to health-contract'],
      testStrategy: 'Run health contract tests against the fake provider',
      atomic: true,
      dependsOn: ['T_INTERFACE', 'T_CONTRACT_TEST'],
    },
    {
      id: 'T1',
      title: 'Implement health walking skeleton',
      kind: 'VERTICAL_SKELETON',
      description: 'A deterministic CI task used to exercise the full Ariad workflow.',
      componentId: 'health-feature',
      verticalSliceId: 'health-slice',
      acceptanceCriteria: ['health.txt contains status=healthy after one semantic retry'],
      testStrategy: 'Tester and Reviewer read health.txt through OpenClaw tools',
      atomic: true,
      dependsOn: ['T_FAKE', 'T_CONTRACT_TEST'],
    },
  ];
  return {
    currentState: {
      existingProject,
      summary: existingProject ? 'Existing Node-style project with a README and Git history.' : 'Greenfield project.',
      keyFiles: existingProject ? ['README.md'] : [],
      knownConstraints: ['Keep the implementation deterministic and small'],
    },
    architecture: {
      horizontals: [{ id: 'runtime', name: 'Runtime', responsibility: 'Shared runtime and application shell' }],
      verticals: [{ id: 'health-feature', name: 'Health feature', responsibility: 'Provide the user-visible health state' }],
    },
    contracts: [{
      id: 'health-contract',
      provider: 'health-feature',
      consumers: ['runtime'],
      purpose: 'Expose deterministic health state',
      interface: 'health.txt contains status and cycle fields',
      testBoundary: 'Read health.txt and verify status=healthy',
      maturity: 'PROVISIONAL',
      justifiedByVerticals: ['health-slice'],
      interfaceTaskId: 'T_INTERFACE',
      contractTestTaskId: 'T_CONTRACT_TEST',
      fakeTaskId: 'T_FAKE',
    }],
    dependencies: [{
      from: 'runtime',
      to: 'health-feature',
      contractId: 'health-contract',
      implementationRequired: false,
      rationale: 'The application shell consumes the health contract; the vertical can be exercised against the fake provider before a richer provider exists.',
    }],
    verticalSlices: [{
      id: 'health-slice',
      name: 'Health state walking skeleton',
      goal: 'Exercise the user-visible health path end to end with the smallest implementation.',
      componentIds: ['runtime', 'health-feature'],
      contractIds: ['health-contract'],
      skeletonTest: 'Developer writes health.txt; Tester and Reviewer read it through OpenClaw and verify the observable state.',
      skeletonTaskId: 'T1',
      taskIds: tasks.map((task) => task.id),
    }],
    technicalDirection: {
      summary: 'Preserve the existing Node/Git project and use a deterministic file contract for the CI feature.',
      foundations: ['Node.js', 'Git'],
      languages: [{ scope: 'application', language: 'JavaScript', rationale: 'Matches the existing project and CI harness' }],
      decisions: [{ decision: 'Use the existing single-project workspace', rationale: 'Avoid unnecessary infrastructure' }],
    },
    decomposition: {
      nodes: [
        { id: 'runtime', parentId: null, kind: 'component', componentId: 'runtime', children: [], taskId: null },
        { id: 'health-feature', parentId: null, kind: 'component', componentId: 'health-feature', children: tasks.map((task) => `${task.id}-node`), taskId: null },
        ...tasks.map((task) => ({ id: `${task.id}-node`, parentId: 'health-feature', kind: 'task', componentId: task.componentId, children: [], taskId: task.id })),
      ],
    },
    tasks,
  };
}

function roleReply(request) {
  const cycle = requestCycle(request);
  const role = requestRole(request);
  const taskId = requestTaskId(request);

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
      result: {
        source: 'fake-provider',
        reason: 'The current-state reconstruction and next vertical slice preserve the requested customer outcome without speculative infrastructure.',
        guidance: '',
        customerOutcomeSummary: 'Existing project understood; TL design is materialized into implementation tasks before the health walking skeleton runs.',
        questions: [],
      },
    };
  }
  if (role === 'developer') return { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTATION_READY', result: { source: 'fake-provider', cycle, taskId, toolExecuted: hasToolResult(request) } };
  if (role === 'tester') return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle, taskId, toolExecuted: hasToolResult(request) } };
  if (role === 'reviewer' && taskId === 'T1' && cycle === 1) return { executionStatus: 'COMPLETED', outcome: 'NOT_PASS', result: { source: 'fake-provider', cycle, taskId, toolExecuted: hasToolResult(request), findings: ['health endpoint still needs the semantic fix'] } };
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
    json(res, { object: 'list', data: [{ id: 'fake', object: 'model', owned_by: 'ariad-ci' }] });
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body || '{}');
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

    const reply = JSON.stringify(roleReply(request));
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
