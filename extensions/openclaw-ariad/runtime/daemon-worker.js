import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(process.argv[2] ?? process.env.ARIAD_PROJECT_ROOT ?? '');
if (!projectRoot || !existsSync(join(projectRoot, 'project.json'))) {
  console.error('Ariad daemon requires a valid project root');
  process.exit(2);
}

const ariadDir = join(projectRoot, '.ariad');
const pidFile = join(ariadDir, 'daemon.pid');
const heartbeatFile = join(ariadDir, 'daemon.heartbeat.json');
mkdirSync(ariadDir, { recursive: true });

const project = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf8'));
let stopping = false;

function heartbeat(state = 'RUNNING') {
  writeFileSync(heartbeatFile, `${JSON.stringify({
    projectId: project.id,
    pid: process.pid,
    state,
    at: new Date().toISOString(),
    stateDb: process.env.ARIAD_STATE_DB ?? join(ariadDir, 'state.db'),
  }, null, 2)}\n`, 'utf8');
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  heartbeat('STOPPING');
  try {
    if (existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) rmSync(pidFile, { force: true });
  } catch {}
  heartbeat('STOPPED');
  console.log(`[ariad:${project.id}] stopped by ${signal}`);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

heartbeat();
console.log(`[ariad:${project.id}] daemon started pid=${process.pid} root=${projectRoot}`);
setInterval(() => heartbeat(), 2000).unref();
setInterval(() => {}, 60_000);
