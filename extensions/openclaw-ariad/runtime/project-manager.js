import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
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

function ensureAriadGitignore(ariadDir) {
  const file = join(ariadDir, '.gitignore');
  if (!existsSync(file)) {
    writeFileSync(file, 'state.db-wal\nstate.db-shm\nstate.db-journal\n', 'utf8');
  }
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
    const workspace = join(root, 'workspace');
    const ariad = join(workspace, '.ariad');
    return {
      id,
      root,
      workspace,
      ariad,
      manifest: join(ariad, 'project.json'),
      db: join(ariad, 'state.db'),
      legacyManifest: join(root, 'project.json'),
      legacyAriad: join(root, '.ariad'),
    };
  }

  migrateLegacyLayout(name) {
    if (!['NEW', 'TAKEOVER'].includes(mode)) throw new Error(`invalid project mode: ${mode}`);
    const p = this.paths(name);
    if (existsSync(p.manifest) || !existsSync(p.legacyManifest)) return p;
    mkdirSync(p.workspace, { recursive: true });
    if (existsSync(p.legacyAriad) && !existsSync(p.ariad)) {
      renameSync(p.legacyAriad, p.ariad);
    } else {
      mkdirSync(p.ariad, { recursive: true });
    }
    const legacy = readJson(p.legacyManifest);
    ensureAriadGitignore(p.ariad);
    if (!existsSync(p.manifest)) renameSync(p.legacyManifest, p.manifest);
    writeJson(p.manifest, {
      ...legacy,
      workspace: p.workspace,
      stateDb: p.db,
    });
    return p;
  }

  create(name, { goal = null, mode = 'NEW', sourcePath = null, frontdeskBinding = null, projectAgent = undefined } = {}) {
    const p = this.paths(name);
    if (existsSync(p.manifest) || existsSync(p.legacyManifest)) throw new Error(`Ariad project already exists: ${p.id}`);
    mkdirSync(p.workspace, { recursive: true });
    mkdirSync(p.ariad, { recursive: true });
    ensureAriadGitignore(p.ariad);
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
      mode: effectiveMode,
      sourcePath: sourcePath ? resolve(sourcePath) : null,
      createdAt,
      workspace: p.workspace,
      stateDb: p.db,
      desiredState: 'STOPPED',
      executionState: 'IDLE',
      frontdeskBinding: frontdeskBinding ?? projectAgent ?? null,
    });
    return this.status(p.id);
  }

  list() {
    if (!existsSync(this.projectsRoot)) return [];
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const p = this.paths(entry.name);
        return existsSync(p.manifest) || existsSync(p.legacyManifest);
      })
      .map((entry) => this.status(entry.name));
  }

  status(name) {
    const p = this.migrateLegacyLayout(name);
    if (!existsSync(p.manifest)) throw new Error(`unknown Ariad project: ${p.id}`);
    const manifest = readJson(p.manifest);
    const frontdeskBinding = manifest.frontdeskBinding ?? manifest.projectAgent ?? null;
    const { projectAgent: _legacyProjectAgent, ...rest } = manifest;
    return {
      ...rest,
      frontdeskBinding,
      executionState: manifest.executionState ?? 'IDLE',
      root: p.root,
    };
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

  bindFrontdesk(name, frontdeskBinding) {
    const p = this.paths(name);
    const current = this.status(p.id);
    writeJson(p.manifest, { ...current, root: undefined, frontdeskBinding });
    return this.status(p.id);
  }

  unbindFrontdesk(name) {
    return this.bindFrontdesk(name, null);
  }

  bindProjectAgent(name, projectAgent) {
    return this.bindFrontdesk(name, projectAgent);
  }
}

export function defaultProjectsRoot(homeDir) {
  return join(homeDir, '.openclaw', 'ariad', 'projects');
}

export { slugify };
