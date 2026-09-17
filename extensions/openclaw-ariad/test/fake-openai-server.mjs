import http from 'node:http';

const port = Number(process.env.ARIAD_FAKE_PROVIDER_PORT || 18081);

function requestText(request) {
  return (request.messages ?? []).map((message) => {
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content)) return message.content.map((part) => part?.text ?? '').join(' ');
    return '';
  }).join('\n');
}

function roleReply(request) {
  const text = requestText(request);
  const cycle = Number(text.match(/"devCycle":(\d+)/)?.[1] ?? 0);
  const role = text.match(/Ariad(?:'s| the)?\s+(developer|tester|reviewer|project_debugger|pm|system_debugger|artist)\s+role/i)?.[1]?.toLowerCase();

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
          acceptanceCriteria: ['implementation is reviewed successfully after one semantic retry'],
          dependsOn: [],
        }],
      },
    };
  }
  if (role === 'developer') {
    return { executionStatus: 'COMPLETED', outcome: 'IMPLEMENTATION_READY', result: { source: 'fake-provider', cycle } };
  }
  if (role === 'tester') {
    return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle } };
  }
  if (role === 'reviewer' && cycle === 1) {
    return { executionStatus: 'COMPLETED', outcome: 'NOT_PASS', result: { source: 'fake-provider', cycle, findings: ['intentional first-cycle rejection'] } };
  }
  if (role === 'reviewer') {
    return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider', cycle } };
  }
  return { executionStatus: 'COMPLETED', outcome: 'PASS', result: { source: 'fake-provider' } };
}

function json(res, value) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
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
    const reply = JSON.stringify(roleReply(request));
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const id = `chatcmpl-${Date.now()}`;
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    json(res, {
      id: `chatcmpl-${Date.now()}`,
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
