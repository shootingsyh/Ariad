import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LspClient } from './lsp-client.js';

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function flattenDocumentSymbols(symbols, parents = []) {
  const out = [];
  for (const symbol of symbols ?? []) {
    const qualified = [...parents, symbol.name].filter(Boolean).join('.');
    out.push({
      name: symbol.name,
      qualifiedName: qualified,
      kind: symbol.kind,
      range: symbol.range,
      selectionRange: symbol.selectionRange ?? symbol.range,
    });
    if (Array.isArray(symbol.children)) {
      out.push(...flattenDocumentSymbols(symbol.children, [...parents, symbol.name]));
    }
  }
  return out;
}

function locationToAnchor(location, workspace) {
  if (!location) return null;
  const uri = location.uri ?? location.targetUri;
  const range = location.range ?? location.targetSelectionRange ?? location.targetRange;
  if (!uri || !range) return null;
  const absolute = fileURLToPath(uri);
  const root = resolve(workspace);
  const file = absolute.startsWith(root) ? absolute.slice(root.length + 1) : absolute;
  return {
    file,
    startLine: range.start.line + 1,
    startCharacter: range.start.character,
    endLine: range.end.line + 1,
    endCharacter: range.end.character,
  };
}

export class GodotLspProvider {
  constructor({
    workspace,
    host = '127.0.0.1',
    port = 6005,
    command = 'godot',
    launch = false,
    startupTimeoutMs = 15000,
    requestTimeoutMs = 5000,
  } = {}) {
    if (!workspace) throw new Error('GodotLspProvider requires workspace');
    this.workspace = resolve(workspace);
    this.host = host;
    this.port = port;
    this.command = command;
    this.launch = launch;
    this.startupTimeoutMs = startupTimeoutMs;
    this.client = new LspClient({ host, port, requestTimeoutMs });
    this.child = null;
    this.initialized = false;
  }

  async start() {
    if (this.initialized) return;
    if (this.launch && !this.child) {
      this.child = spawn(this.command, [
        '--editor',
        '--headless',
        '--no-header',
        '--path',
        this.workspace,
        '--lsp-port',
        String(this.port),
      ], {
        cwd: this.workspace,
        stdio: 'ignore',
      });
      this.child.once('exit', () => {
        this.child = null;
        this.initialized = false;
      });
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await this.client.connect();
        await this.client.initialize({
          rootUri: pathToFileURL(this.workspace).href,
          capabilities: {
            workspace: { symbol: { resolveSupport: { properties: ['location.range'] } } },
            textDocument: {
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              definition: { linkSupport: true },
              references: {},
            },
          },
        });
        this.initialized = true;
        return;
      } catch (error) {
        lastError = error;
        await sleep(150);
      }
    }
    throw new Error(`Godot LSP unavailable at ${this.host}:${this.port}: ${lastError?.message ?? 'timeout'}`);
  }

  async documentSymbols(file) {
    await this.start();
    const absolute = resolve(this.workspace, file);
    accessSync(absolute, constants.R_OK);
    const result = await this.client.request('textDocument/documentSymbol', {
      textDocument: { uri: pathToFileURL(absolute).href },
    });
    if (!Array.isArray(result)) return [];
    if (result.length > 0 && result[0]?.location) {
      return result.map(item => ({
        name: item.name,
        qualifiedName: [item.containerName, item.name].filter(Boolean).join('.'),
        kind: item.kind,
        range: item.location.range,
        selectionRange: item.location.range,
      }));
    }
    return flattenDocumentSymbols(result);
  }

  async workspaceSymbols(query) {
    await this.start();
    const result = await this.client.request('workspace/symbol', { query });
    return (result ?? []).map(item => ({
      name: item.name,
      qualifiedName: [item.containerName, item.name].filter(Boolean).join('.'),
      kind: item.kind,
      location: locationToAnchor(item.location, this.workspace),
    }));
  }

  async resolveSymbol({ file = null, symbol }) {
    if (!symbol) throw new Error('resolveSymbol requires symbol');
    const wanted = String(symbol);
    const leaf = wanted.split('.').at(-1);

    if (file) {
      const symbols = await this.documentSymbols(file);
      const exact = symbols.find(item =>
        item.qualifiedName === wanted
        || item.name === wanted
        || item.name === leaf
        || item.qualifiedName.endsWith(`.${wanted}`)
      );
      if (exact?.range) {
        return {
          kind: 'symbol',
          file,
          symbol: wanted,
          startLine: exact.range.start.line + 1,
          startCharacter: exact.range.start.character,
          endLine: exact.range.end.line + 1,
          endCharacter: exact.range.end.character,
          provider: 'godot-lsp',
        };
      }
    }

    const candidates = await this.workspaceSymbols(leaf);
    const exact = candidates.find(item =>
      item.qualifiedName === wanted
      || item.name === wanted
      || item.name === leaf
      || item.qualifiedName.endsWith(`.${wanted}`)
    );
    if (!exact?.location) return null;
    return {
      kind: 'symbol',
      file: exact.location.file,
      symbol: wanted,
      startLine: exact.location.startLine,
      startCharacter: exact.location.startCharacter,
      endLine: exact.location.endLine,
      endCharacter: exact.location.endCharacter,
      provider: 'godot-lsp',
    };
  }

  async definition({ file, line, character = 0 }) {
    await this.start();
    const absolute = resolve(this.workspace, file);
    const result = await this.client.request('textDocument/definition', {
      textDocument: { uri: pathToFileURL(absolute).href },
      position: { line: Math.max(0, line - 1), character },
    });
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    return locations.map(item => locationToAnchor(item, this.workspace)).filter(Boolean);
  }

  async references({ file, line, character = 0, includeDeclaration = true }) {
    await this.start();
    const absolute = resolve(this.workspace, file);
    const result = await this.client.request('textDocument/references', {
      textDocument: { uri: pathToFileURL(absolute).href },
      position: { line: Math.max(0, line - 1), character },
      context: { includeDeclaration },
    });
    return (result ?? []).map(item => locationToAnchor(item, this.workspace)).filter(Boolean);
  }

  async close() {
    try {
      if (this.initialized) await this.client.shutdown();
    } catch {
      // Server may already be gone.
    }
    this.initialized = false;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  describe() {
    return {
      id: 'godot-lsp',
      workspace: this.workspace,
      host: this.host,
      port: this.port,
      project: basename(this.workspace),
    };
  }
}
