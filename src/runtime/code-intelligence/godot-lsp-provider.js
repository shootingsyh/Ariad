import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { JsonRpcTcpClient } from './json-rpc-tcp-client.js';

function toUri(file) {
  return pathToFileURL(resolve(file)).href;
}

function flattenDocumentSymbols(items, out = []) {
  for (const item of items ?? []) {
    out.push(item);
    if (Array.isArray(item.children)) flattenDocumentSymbols(item.children, out);
  }
  return out;
}

// The project's language server is owned by the project runtime and
// shares the project's lifecycle: the runtime creates exactly one
// GodotLspProvider per project, every session only uses it, and only the
// runtime closes it. Editor processes spawned here carry a birthmark so a
// later daemon generation can reap the ones a hard-killed daemon could
// not shut down.
export const LSP_CHILD_MARK_ENV = 'ARIAD_LSP_CHILD';

export function lspChildMarkFor(projectPath) {
  return createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 16);
}

export function sweepOrphanedLspChildren(mark, port) {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return 0; // no /proc (non-Linux): nothing to sweep
  }
  let killed = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (!environ.includes(`${LSP_CHILD_MARK_ENV}=${mark}`)) continue;
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
      if (!cmdline.includes('--editor')) continue;
      if (!cmdline.includes(`--lsp-port ${port}`) && !cmdline.includes(`--lsp-port=${port}`)) continue;
      process.kill(pid, 'SIGTERM');
      killed += 1;
    } catch {
      // Already gone or not readable: not ours to reap.
    }
  }
  if (killed > 0) {
    console.log(`[godot-lsp] reaped ${killed} orphaned editor process(es) from a previous daemon generation`);
  }
  return killed;
}

const sweptChildMarks = new Set();

function sweepOrphanedLspChildrenOnce(mark, port) {
  if (sweptChildMarks.has(mark)) return;
  sweptChildMarks.add(mark);
  try {
    sweepOrphanedLspChildren(mark, port);
  } catch {
    // The sweep must never break language-server startup.
  }
}

export class GodotLspProvider {
  constructor({
    projectPath,
    godotBinary = process.env.GODOT_BIN ?? 'godot',
    host = '127.0.0.1',
    port = 6005,
    launch = true,
    startupTimeoutMs = 15_000,
    requestTimeoutMs = 10_000,
  } = {}) {
    if (!projectPath) throw new Error('GodotLspProvider requires projectPath');
    this.projectPath = resolve(projectPath);
    this.godotBinary = godotBinary;
    this.host = host;
    this.port = port;
    this.launch = launch;
    this.startupTimeoutMs = startupTimeoutMs;
    this.client = new JsonRpcTcpClient({ host, port, requestTimeoutMs });
    this.process = null;
    this.initialized = false;
    this.starting = null;
    this.childMark = lspChildMarkFor(this.projectPath);
  }

  async start() {
    if (this.initialized) return;
    if (!this.starting) {
      this.starting = this.#startOnce().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async #startOnce() {
    if (this.launch && !this.process) {
      sweepOrphanedLspChildrenOnce(this.childMark, this.port);
      const child = spawn(this.godotBinary, [
        '--editor',
        '--path', this.projectPath,
        '--lsp-port', String(this.port),
        '--headless',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, [LSP_CHILD_MARK_ENV]: this.childMark },
      });
      this.process = child;
      const onGone = () => {
        if (this.process === child) this.process = null;
        // The editor is gone. The owner keeps this server alive for the
        // project's whole lifetime, so forget the initialized state and
        // drop the client: the next use revives the editor instead of
        // talking to a corpse.
        this.initialized = false;
        try { this.client.close(); } catch { /* noop */ }
      };
      child.once('exit', onGone);
      child.once('error', onGone);
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await this.client.connect();
        break;
      } catch (error) {
        lastError = error;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
      }
    }
    if (!this.client.socket) {
      throw new Error(`Godot LSP did not become ready: ${lastError?.message ?? 'timeout'}`);
    }

    await this.client.request('initialize', {
      processId: process.pid,
      rootUri: toUri(this.projectPath),
      capabilities: {
        textDocument: {
          documentSymbol: {},
          definition: {},
          references: {},
        },
        workspace: {
          symbol: {},
        },
      },
      workspaceFolders: [{
        uri: toUri(this.projectPath),
        name: this.projectPath.split(/[\\/]/).pop(),
      }],
    });
    await this.client.notify('initialized', {});
    this.initialized = true;
  }

  async documentSymbols(filePath) {
    await this.start();
    const result = await this.client.request('textDocument/documentSymbol', {
      textDocument: { uri: toUri(filePath) },
    });
    return flattenDocumentSymbols(result);
  }

  async findSymbol(filePath, symbolName) {
    const symbols = await this.documentSymbols(filePath);
    const exact = symbols.find(symbol => symbol.name === symbolName);
    if (exact) return exact;
    return symbols.find(symbol => symbol.name?.endsWith(`.${symbolName}`) || symbol.name?.includes(symbolName)) ?? null;
  }

  async definition(filePath, line, character = 0) {
    await this.start();
    return this.client.request('textDocument/definition', {
      textDocument: { uri: toUri(filePath) },
      position: { line, character },
    });
  }

  async references(filePath, line, character = 0, { includeDeclaration = true } = {}) {
    await this.start();
    return this.client.request('textDocument/references', {
      textDocument: { uri: toUri(filePath) },
      position: { line, character },
      context: { includeDeclaration },
    });
  }

  async workspaceSymbols(query) {
    await this.start();
    return this.client.request('workspace/symbol', { query });
  }

  async resolveSymbol({ file, symbol }) {
    const absolute = resolve(this.projectPath, file);
    const found = await this.findSymbol(absolute, String(symbol).split('.').pop());
    if (!found) return null;
    const range = found.selectionRange ?? found.range ?? null;
    if (!range) return null;
    return {
      kind: 'symbol',
      file,
      symbol,
      startLine: range.start.line + 1,
      startCharacter: range.start.character,
      endLine: range.end.line + 1,
      endCharacter: range.end.character,
      provider: 'godot-lsp',
    };
  }

  async close() {
    if (this.starting) {
      // Never let a close race an in-flight start into a leaked editor.
      try { await this.starting; } catch { /* start failed; nothing live to shut down */ }
    }
    if (this.initialized) {
      try { await this.client.request('shutdown'); } catch {}
      try { await this.client.notify('exit'); } catch {}
    }
    this.client.close();
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.initialized = false;
  }
}
