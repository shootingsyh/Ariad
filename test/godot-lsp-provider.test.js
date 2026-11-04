import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { GodotLspProvider, LSP_CHILD_MARK_ENV, lspChildMarkFor, sweepOrphanedLspChildren } from '../src/runtime/code-intelligence/godot-lsp-provider.js';

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

const FAKE_GODOT_SCRIPT = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  'const CRLF = String.fromCharCode(13, 10);',
  'const args = process.argv.slice(2);',
  "const port = Number(args[args.indexOf('--lsp-port') + 1]);",
  'if (process.env.FAKE_GODOT_COUNTFILE) {',
  '  let n = 0;',
  "  try { n = Number(fs.readFileSync(process.env.FAKE_GODOT_COUNTFILE, 'utf8')) || 0; } catch {}",
  "  fs.writeFileSync(process.env.FAKE_GODOT_COUNTFILE, String(n + 1));",
  '}',
  "if (process.env.FAKE_GODOT_PIDFILE) fs.writeFileSync(process.env.FAKE_GODOT_PIDFILE, String(process.pid));",
  'function encode(payload) {',
  '  const body = JSON.stringify(payload);',
  "  return 'Content-Length: ' + Buffer.byteLength(body, 'utf8') + CRLF + CRLF + body;",
  '}',
  'const server = net.createServer(socket => {',
  '  let buffer = Buffer.alloc(0);',
  "  socket.on('data', chunk => {",
  '    buffer = Buffer.concat([buffer, chunk]);',
  '    while (true) {',
  '      const boundary = buffer.indexOf(CRLF + CRLF);',
  '      if (boundary < 0) return;',
  "      const header = buffer.subarray(0, boundary).toString('utf8');",
  "      const length = Number(header.split(':')[1].trim());",
  '      const start = boundary + 4;',
  '      const end = start + length;',
  '      if (buffer.length < end) return;',
  "      const message = JSON.parse(buffer.subarray(start, end).toString('utf8'));",
  '      buffer = buffer.subarray(end);',
  '      if (message.id == null) continue;',
  "      if (message.method === 'textDocument/documentSymbol') {",
  "        socket.write(encode({ jsonrpc: '2.0', id: message.id, result: [{ name: 'new_game', kind: 12, range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, selectionRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 13 } } }] }));",
  '      } else {',
  "        socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));",
  '      }',
  '    }',
  '  });',
  '});',
  "server.listen(port, '127.0.0.1');",
  '',
].join('\n');

function writeFakeGodot(root) {
  const script = path.join(root, 'fake-godot.js');
  fs.writeFileSync(script, FAKE_GODOT_SCRIPT, { mode: 0o755 });
  return script;
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

test('Godot LSP provider revives its editor when the child dies (owner keepalive)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-godot-lsp-revive-'));
  const countFile = path.join(root, 'spawns.txt');
  const pidFile = path.join(root, 'child.pid');
  process.env.FAKE_GODOT_COUNTFILE = countFile;
  process.env.FAKE_GODOT_PIDFILE = pidFile;
  try {
    fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="fixture"\n');
    const entry = path.join(root, 'entry.gd');
    fs.writeFileSync(entry, 'extends Node\n\nfunc new_game():\n\treturn true\n');
    const provider = new GodotLspProvider({
      projectPath: root,
      godotBinary: writeFakeGodot(root),
      port: await freePort(),
      startupTimeoutMs: 8_000,
      requestTimeoutMs: 2_000,
    });
    const first = await provider.findSymbol(entry, 'new_game');
    assert.equal(first.name, 'new_game');
    assert.equal(fs.readFileSync(countFile, 'utf8'), '1');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    process.kill(childPid, 'SIGKILL');
    await waitFor(() => provider.process === null && !provider.initialized);
    const second = await provider.findSymbol(entry, 'new_game');
    assert.equal(second.name, 'new_game');
    assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
    await provider.close();
  } finally {
    delete process.env.FAKE_GODOT_COUNTFILE;
    delete process.env.FAKE_GODOT_PIDFILE;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Godot LSP provider spawns exactly one editor under concurrent first use', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-godot-lsp-once-'));
  const countFile = path.join(root, 'spawns.txt');
  process.env.FAKE_GODOT_COUNTFILE = countFile;
  try {
    fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="fixture"\n');
    const entry = path.join(root, 'entry.gd');
    fs.writeFileSync(entry, 'extends Node\n\nfunc new_game():\n\treturn true\n');
    const provider = new GodotLspProvider({
      projectPath: root,
      godotBinary: writeFakeGodot(root),
      port: await freePort(),
      startupTimeoutMs: 8_000,
      requestTimeoutMs: 2_000,
    });
    await Promise.all([provider.start(), provider.start(), provider.documentSymbols(entry)]);
    assert.equal(fs.readFileSync(countFile, 'utf8'), '1');
    await provider.close();
  } finally {
    delete process.env.FAKE_GODOT_COUNTFILE;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orphan sweep reaps birthmarked editors from a previous generation and spares unmarked ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-godot-lsp-sweep-'));
  try {
    const fake = writeFakeGodot(root);
    const mark = lspChildMarkFor(root);
    const orphanPort = await freePort();
    const bystanderPort = await freePort();
    const orphan = spawn(fake, ['--editor', '--path', root, '--lsp-port', String(orphanPort), '--headless'], {
      env: { ...process.env, [LSP_CHILD_MARK_ENV]: mark },
      stdio: 'ignore',
    });
    const bystander = spawn(fake, ['--editor', '--path', root, '--lsp-port', String(bystanderPort), '--headless'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      const killed = sweepOrphanedLspChildren(mark, orphanPort);
      assert.ok(killed >= 1, `expected the sweep to reap the marked orphan, killed=${killed}`);
      await waitFor(() => orphan.signalCode !== null || orphan.exitCode !== null);
      assert.equal(bystander.exitCode, null);
      assert.equal(bystander.signalCode, null);
    } finally {
      try { bystander.kill('SIGKILL'); } catch {}
      try { orphan.kill('SIGKILL'); } catch {}
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
