import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

export class AriadProjectManager {
  constructor({ projectsRoot, now = () => new Date() }) {
    if (!projectsRoot) throw new Error('projectsRoot is required');
    this.projectsRoot = resolve(projectsRoot);
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
    };
  }

  create(name, { goal = null, projectAgent = null } = {}) {
    const p = this.paths(name);
    if (existsSync(p.manifest)) throw new Error(`Ariad project already exists: ${p.id}`);
    mkdirSync(p.workspace, { recursive: true });
    mkdirSync(p.ariad, { recursive: true });
    if (!existsSync(join(p.workspace, '.git'))) {
      try {
        execFileSync('git', ['init', '-b', 'main'], { cwd: p.workspace, stdio: 'ignore' });
      } catch (error) {
        throw new Error(`failed to initialize Git workspace for ${p.id}: ${error?.message ?? String(error)}`);
      }
    }
    const createdAt = this.now().toISOString();
    writeJson(p.manifest, {
      id: p.id,
      name: String(name),
      goal,
      createdAt,
      workspace: p.workspace,
      stateDb: p.db,
      desiredState: 'STOPPED',
      executionState: 'IDLE',
      projectAgent,
    });
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
    return { ...manifest, executionState: manifest.executionState ?? 'IDLE', root: p.root };
  }

  setDesiredState(name, desiredState) {
    if (!['RUNNING', 'STOPPED'].includes(desiredState)) throw new Error(`invalid desired state: ${desiredState}`);
    const p = this.paths(name);
    const current = this.status(p.id);
    writeJson(p.manifest, { ...current, root: undefined, desiredState });
    return this.status(p.id);
  }

  setExecutionState(name, executionState) {
    const allowed = ['IDLE', 'PLANNING', 'RUNNING', 'NEEDS_HUMAN', 'FAILED', 'SUCCEEDED'];
    if (!allowed.includes(executionState)) throw new Error(`invalid execution state: ${executionState}`);
    const p = this.paths(name);
    const current = this.status(p.id);
    if (current.executionState === executionState) return current;
    writeJson(p.manifest, { ...current, root: undefined, executionState });
    return this.status(p.id);
  }

  bindProjectAgent(name, projectAgent) {
    const p = this.paths(name);
    const current = this.status(p.id);
    writeJson(p.manifest, { ...current, root: undefined, projectAgent });
    return this.status(p.id);
  }
}

export function defaultProjectsRoot(homeDir) {
  return join(homeDir, '.openclaw', 'ariad', 'projects');
}

export { slugify };
