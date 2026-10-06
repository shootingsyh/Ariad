import { spawn } from 'node:child_process';
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
  }

  async start() {
    if (this.initialized) return;
    if (this.launch && !this.process) {
      this.process = spawn(this.godotBinary, [
        '--editor',
        '--path', this.projectPath,
        '--lsp-port', String(this.port),
        '--headless',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.process.once('exit', (code, signal) => {
        if (!this.initialized && code !== 0) {
          // Connection retry below surfaces startup failure deterministically.
        }
        this.process = null;
      });
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
