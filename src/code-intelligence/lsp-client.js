import net from 'node:net';

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

export class LspClient {
  constructor({ host = '127.0.0.1', port, requestTimeoutMs = 5000 } = {}) {
    if (!port) throw new Error('LspClient requires port');
    this.host = host;
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.socket) return;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const onError = error => {
        socket.off('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off('error', onError);
        this.socket = socket;
        socket.on('data', chunk => this.#onData(chunk));
        socket.on('error', error => this.#rejectAll(error));
        socket.on('close', () => {
          this.#rejectAll(new Error('LSP connection closed'));
          this.socket = null;
        });
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  async initialize({ rootUri, processId = process.pid, capabilities = {} } = {}) {
    await this.connect();
    const result = await this.request('initialize', {
      processId,
      rootUri: rootUri ?? null,
      capabilities,
      clientInfo: { name: 'ariad', version: '0.1.0' },
    });
    this.notify('initialized', {});
    return result;
  }

  request(method, params = null) {
    if (!this.socket) throw new Error('LSP client is not connected');
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.write(encodeMessage(payload));
    });
  }

  notify(method, params = null) {
    if (!this.socket) throw new Error('LSP client is not connected');
    this.socket.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  async shutdown() {
    if (!this.socket) return;
    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
    } finally {
      this.socket.end();
      this.socket = null;
    }
  }

  #rejectAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const split = this.buffer.indexOf('\r\n\r\n');
      if (split < 0) return;
      const header = this.buffer.subarray(0, split).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error('LSP message missing Content-Length');
      const length = Number(match[1]);
      const bodyStart = split + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      const message = JSON.parse(body);
      if (message.id == null) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`LSP ${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }
}
