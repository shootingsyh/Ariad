import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GodotLspProvider } from '../src/runtime/code-intelligence/godot-lsp-provider.js';

function encode(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function createFakeLspServer() {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const header = buffer.subarray(0, boundary).toString('utf8');
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) return;
        const length = Number(match[1]);
        const start = boundary + 4;
        const end = start + length;
        if (buffer.length < end) return;
        const message = JSON.parse(buffer.subarray(start, end).toString('utf8'));
        buffer = buffer.subarray(end);
        if (message.id == null) continue;
        if (message.method === 'initialize') {
          socket.write(encode({
            jsonrpc: '2.0',
            id: message.id,
            result: { capabilities: { documentSymbolProvider: true } },
          }));
        } else if (message.method === 'textDocument/documentSymbol') {
          socket.write(encode({
            jsonrpc: '2.0',
            id: message.id,
            result: [{
              name: 'new_game',
              kind: 12,
              range: {
                start: { line: 2, character: 0 },
                end: { line: 4, character: 0 },
              },
              selectionRange: {
                start: { line: 2, character: 5 },
                end: { line: 2, character: 13 },
              },
            }],
          }));
        } else if (message.method === 'shutdown') {
          socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));
        } else {
          socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));
        }
      }
    });
  });
  return server;
}

test('Godot LSP provider speaks JSON-RPC/TCP and resolves a document symbol', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-godot-lsp-'));
  const server = createFakeLspServer();
  try {
    fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="fixture"\n');
    fs.writeFileSync(path.join(root, 'entry.gd'), 'extends Node\n\nfunc new_game():\n\treturn true\n');

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const provider = new GodotLspProvider({
      projectPath: root,
      host: '127.0.0.1',
      port: address.port,
      launch: false,
      requestTimeoutMs: 2_000,
    });

    const symbol = await provider.findSymbol(path.join(root, 'entry.gd'), 'new_game');
    assert.equal(symbol.name, 'new_game');
    assert.equal(symbol.selectionRange.start.line, 2);
    await provider.close();
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
