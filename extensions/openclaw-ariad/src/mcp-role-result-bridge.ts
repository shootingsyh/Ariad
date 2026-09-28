import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

type RoleResultPayload = {
  attemptId: string;
  outcome: string;
  summary: string;
  keyPoints?: string[];
  artifacts?: string[];
  result?: unknown;
};

type AttemptBinding = {
  projectId: string;
  taskId: string;
  role: string;
  attemptId: string;
  harness?: string;
  provider?: string;
  model?: string;
};

function tokenPath(projectsRoot: string) {
  return join(projectsRoot, '.runtime', 'mcp-role-result-token');
}

export function ensureMcpRoleResultToken(projectsRoot: string) {
  const path = tokenPath(projectsRoot);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  try { chmodSync(path, 0o600); } catch {}
  return readFileSync(path, 'utf8').trim();
}

function send(res: any, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req: any) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class AriadMcpRoleResultBridge {
  private server: Server | null = null;
  constructor(private readonly options: {
    projectsRoot: string;
    host?: string;
    port?: number;
    logger?: any;
    resolveAttempt: (attemptId: string) => AttemptBinding | null;
    submit: (attemptId: string, role: string, payload: RoleResultPayload) => Promise<unknown> | unknown;
    terminate?: (attemptId: string) => void;
  }) {}

  async start() {
    if (this.server) return;
    const token = ensureMcpRoleResultToken(this.options.projectsRoot);
    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? Number(process.env.ARIAD_MCP_ROLE_RESULT_PORT || 18792);
    this.server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/role-result') {
          send(res, 404, { error: 'not found' });
          return;
        }
        if (req.headers.authorization !== `Bearer ${token}`) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const payload = await readJson(req) as RoleResultPayload;
        if (!payload?.attemptId || !payload?.outcome || !payload?.summary) {
          send(res, 400, { error: 'attemptId, outcome, and summary are required' });
          return;
        }
        const binding = this.options.resolveAttempt(payload.attemptId);
        if (!binding) {
          send(res, 409, { error: `No active Ariad attempt binding for ${payload.attemptId}` });
          return;
        }
        if (binding.attemptId !== payload.attemptId) {
          send(res, 409, { error: 'attempt binding mismatch' });
          return;
        }
        const result = await this.options.submit(payload.attemptId, binding.role, payload);
        send(res, 200, { accepted: true, role: binding.role, result });
        this.options.terminate?.(payload.attemptId);
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.options.logger?.info?.(`Ariad MCP role-result bridge listening on http://${host}:${port}`);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
