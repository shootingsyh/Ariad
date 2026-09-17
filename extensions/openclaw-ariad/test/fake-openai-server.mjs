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
  return requestText(request).match(/Ariad(?:'s| the)?\s+(developer|tester|reviewer|project_debugger|pm|system_debugger|artist)\s+role/i)?.[1]?.toLowerCase() ?? null;
}

function requestCycle(request) {
  return Number(requestText(request).match(/"devCycle":(\d+)/)?.[1] ?? 0);
}

function hasWorkspace(request) {
  return /"workspace":"[^"]+"/.test(requestText(request));
}

function hasToolResult(request) {
  return (request.messages ?? []).some((message) => message?.role === 'tool');
}

function isProjectExecutionRole(request) {
  const role = requestRole(request);
  return /"taskId":"T1"/.test(requestText(request)) && ['developer', 'tester', 'reviewer'].includes(role);
}

function toolCallFor(request) {
  if (!hasWorkspace(request) || hasToolResult(request)) return null;
  const role = requestRole(request);
  const cycle = requestCycle(request);
  if (role === 'developer') {
    return {
      name: 'write',
      arguments: {
        path: 'health.txt',
        content: cycle === 1 ? 'status=needs-review\ncycle=1\n' : 'status=healthy\ncycle=2\n',
      },
    };
  }
  if (role === 'tester' || role === 'reviewer') {
    return { name: 'read', arguments: { path: 'health.txt' } };
  }
  return null;
}

function roleReply(request) {
  const cycle = requestCycle(request);
  const role = requestRole(request);

  if (isProjectExecutionRole(request) && (!hasWorkspace(request) || !hasToolResult(request))) {
    return {
      executionStatus: 'FAILED',
      failure: !hasWorkspace(request) ? 'FAKE_E2E_WORKSPACE_MISSING' : 'FAKE_E2E_TOOL_RESULT_MISSING',
    };
  }

  if (role === 'pm') {
    return {
      executionStatus: 'COMPLETED',
      outcome: 'REPLANNED',
      result: {
        source: 'fake-provider',
        tasks: [{
          id: 'T1',
          title: 'Implement fake health endpoint',
          description: 'A deterministic CI task used to exercise the full Ariad workflow.',
          acceptanceCriteria: ['health.txt contains status=healthy after one semantic retry'],
          dependsOn: [],
        }],
      },
    };
  }
  if (role === 'developer') {
    return { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTATION_READY', result: { source: 'fake-provider', cycle, toolExecuted: hasToolResult(request) } };
  }
  if (role === 'tester') {
    return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle, toolExecuted: hasToolResult(request) } };
  }
  if (role === 'reviewer' && cycle === 1) {
    return { executionStatus: 'COMPLETED', outcome: 'NOT_PASS', result: { source: 'fake-provider', cycle, toolExecuted: hasToolResult(request), findings: ['health endpoint still needs the semantic fix'] } };
  }
  if (role === 'reviewer') {
    return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle, toolExecuted: hasToolResult(request) } };
  }
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
      const call = {
        index: 0,
        id: callId,
        type: 'function',
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
      };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] });
        streamChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      json(res, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
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
    json(res, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ARIAD_FAKE_PROVIDER_READY ${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
