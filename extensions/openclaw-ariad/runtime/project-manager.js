import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

function slugify(name) {
  const value = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!value || value === '.' || value === '..') throw new Error('project name must contain letters or numbers');
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class AriadProjectManager {
  constructor({ projectsRoot, daemonEntry, spawn = nodeSpawn, isProcessAlive = defaultIsProcessAlive, kill = process.kill.bind(process), now = () => new Date() }) {
    if (!projectsRoot) throw new Error('projectsRoot is required');
    if (!daemonEntry) throw new Error('daemonEntry is required');
    this.projectsRoot = resolve(projectsRoot);
    this.daemonEntry = resolve(daemonEntry);
    this.spawn = spawn;
    this.isProcessAlive = isProcessAlive;
    this.kill = kill;
    this.now = now;
    mkdirSync(this.projectsRoot, { recursive: true });
  }

  paths(name) {
    const id = slugify(name);
    const root = join(this.projectsRoot, id);
    return {
      id,
      root,
      manifest: join(root, 'project.json'),
      workspace: join(root, 'workspace'),
      ariad: join(root, '.ariad'),
      db: join(root, '.ariad', 'state.db'),
      pid: join(root, '.ariad', 'daemon.pid'),
      lock: join(root, '.ariad', 'daemon.lock'),
      heartbeat: join(root, '.ariad', 'daemon.heartbeat.json'),
      log: join(root, '.ariad', 'daemon.log'),
    };
  }

  create(name, { goal = null } = {}) {
    const p = this.paths(name);
    if (existsSync(p.manifest)) throw new Error(`Ariad project already exists: ${p.id}`);
    mkdirSync(p.workspace, { recursive: true });
    mkdirSync(p.ariad, { recursive: true });
    const createdAt = this.now().toISOString();
    writeJson(p.manifest, { id: p.id, name: String(name), goal, createdAt, workspace: p.workspace, stateDb: p.db });
    return this.status(p.id);
  }

  list() {
    if (!existsSync(this.projectsRoot)) return [];
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.projectsRoot, entry.name, 'project.json')))
      .map((entry) => this.status(entry.name));
  }

  status(name) {
    const p = this.paths(name);
    if (!existsSync(p.manifest)) throw new Error(`unknown Ariad project: ${p.id}`);
    const manifest = readJson(p.manifest);
    let pid = null;
    if (existsSync(p.pid)) {
      const parsed = Number(readFileSync(p.pid, 'utf8').trim());
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    }
    const running = this.isProcessAlive(pid);
    if (!running && existsSync(p.pid)) rmSync(p.pid, { force: true });
    let heartbeat = null;
    if (existsSync(p.heartbeat)) {
      try { heartbeat = readJson(p.heartbeat); } catch {}
    }
    return { ...manifest, root: p.root, running, pid: running ? pid : null, heartbeat, log: p.log };
  }

  start(name) {
    const p = this.paths(name);
    const current = this.status(p.id);
    if (current.running) return current;
    mkdirSync(p.ariad, { recursive: true });
    let lockFd;
    try {
      lockFd = openSync(p.lock, 'wx');
      writeFileSync(lockFd, `${process.pid}\n`);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`project start already in progress: ${p.id}`);
      throw error;
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
    }

    try {
      const logFd = openSync(p.log, 'a');
      const child = this.spawn(process.execPath, [this.daemonEntry, p.root], {
        cwd: p.root,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, ARIAD_PROJECT_ROOT: p.root, ARIAD_STATE_DB: p.db },
      });
      closeSync(logFd);
      if (!child?.pid) throw new Error(`failed to start Ariad project daemon: ${p.id}`);
      writeFileSync(p.pid, `${child.pid}\n`, 'utf8');
      child.unref?.();
      return { ...current, running: true, pid: child.pid };
    } finally {
      rmSync(p.lock, { force: true });
    }
  }

  stop(name) {
    const p = this.paths(name);
    const current = this.status(p.id);
    if (!current.running) return current;
    try { this.kill(current.pid, 'SIGTERM'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    rmSync(p.pid, { force: true });
    return { ...current, running: false, pid: null };
  }
}

export function defaultProjectsRoot(homeDir) {
  return join(homeDir, '.openclaw', 'ariad', 'projects');
}

export { slugify };
