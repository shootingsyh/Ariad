import net from 'node:net';

function encodeMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

export class JsonRpcTcpClient {
  constructor({ host = '127.0.0.1', port, requestTimeoutMs = 10_000 } = {}) {
    if (!Number.isInteger(port) || port <= 0) throw new Error('JsonRpcTcpClient requires port');
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
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        this.socket = socket;
        socket.on('data', chunk => this.#onData(chunk));
        socket.on('error', error => this.#failAll(error));
        socket.on('close', () => this.#failAll(new Error('LSP socket closed')));
        resolve();
      });
    });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const header = this.buffer.subarray(0, boundary).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error('JSON-RPC frame missing Content-Length');
      const length = Number(match[1]);
      const start = boundary + 4;
      const end = start + length;
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(start, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      const message = JSON.parse(body);
      if (message.id == null) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? 'JSON-RPC error');
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket = null;
  }

  async request(method, params = null) {
    await this.connect();
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, ...(params == null ? {} : { params }) };
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.write(encodeMessage(payload));
    return result;
  }

  async notify(method, params = null) {
    await this.connect();
    const payload = { jsonrpc: '2.0', method, ...(params == null ? {} : { params }) };
    this.socket.write(encodeMessage(payload));
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
    this.#failAll(new Error('JSON-RPC client closed'));
  }
}
