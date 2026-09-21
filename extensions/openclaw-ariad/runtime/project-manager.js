import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, cpSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeRoleModels } from './role-models.js';

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

function ensureGitRepo(workspace) {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace does not exist or is not a directory: ${workspace}`);
  }
  if (!existsSync(join(workspace, '.git'))) {
    throw new Error(`takeover sourcePath must be an existing Git repository: ${workspace}`);
  }
}

function removableGeneratedWorkspace(workspace) {
  if (!existsSync(workspace)) return true;
  return readdirSync(workspace, { withFileTypes: true })
    .every(entry => ['.git', '.ariad'].includes(entry.name));
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
      adoptedRef: join(root, 'project-ref.json'),
      legacyManifest: join(root, 'project.json'),
      legacyAriad: join(root, '.ariad'),
    };
  }

  resolveProjectPaths(name) {
    const p = this.paths(name);
    if (existsSync(p.adoptedRef)) {
      const ref = readJson(p.adoptedRef);
      const workspace = resolve(ref.workspace);
      const ariad = join(workspace, '.ariad');
      return {
        ...p,
        workspace,
        ariad,
        manifest: join(ariad, 'project.json'),
        db: join(ariad, 'state.db'),
        adopted: true,
      };
    }
    return { ...p, adopted: false };
  }

  migrateLegacyLayout(name) {
    const base = this.paths(name);
    if (existsSync(base.adoptedRef)) return this.resolveProjectPaths(name);
    if (existsSync(base.manifest) || !existsSync(base.legacyManifest)) return { ...base, adopted: false };
    mkdirSync(base.workspace, { recursive: true });
    if (existsSync(base.legacyAriad) && !existsSync(base.ariad)) {
      renameSync(base.legacyAriad, base.ariad);
    } else {
      mkdirSync(base.ariad, { recursive: true });
    }
    const legacy = readJson(base.legacyManifest);
    ensureAriadGitignore(base.ariad);
    if (!existsSync(base.manifest)) renameSync(base.legacyManifest, base.manifest);
    writeJson(base.manifest, {
      ...legacy,
      workspace: base.workspace,
      stateDb: base.db,
    });
    return { ...base, adopted: false };
  }

  create(name, { goal = null, mode = null, sourcePath = null, roleModels = {}, frontdeskBinding = null, projectAgent = undefined } = {}) {
    const effectiveMode = mode ?? (sourcePath ? 'TAKEOVER' : 'NEW');
    if (!['NEW', 'TAKEOVER'].includes(effectiveMode)) throw new Error(`invalid project mode: ${effectiveMode}`);
    const base = this.paths(name);
    if (existsSync(base.manifest) || existsSync(base.legacyManifest) || existsSync(base.adoptedRef)) {
      throw new Error(`Ariad project already exists: ${base.id}`);
    }

    const adoptedWorkspace = effectiveMode === 'TAKEOVER' && sourcePath ? resolve(sourcePath) : null;
    const workspace = adoptedWorkspace ?? base.workspace;
    const ariad = join(workspace, '.ariad');
    const manifest = join(ariad, 'project.json');
    const db = join(ariad, 'state.db');

    if (adoptedWorkspace) {
      ensureGitRepo(adoptedWorkspace);
      if (existsSync(manifest)) {
        throw new Error(`source repository already contains an Ariad project: ${manifest}`);
      }
      mkdirSync(base.root, { recursive: true });
    } else {
      mkdirSync(workspace, { recursive: true });
      if (!existsSync(join(workspace, '.git'))) {
        try {
          execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
        } catch (error) {
          throw new Error(`failed to initialize Git workspace for ${base.id}: ${error?.message ?? String(error)}`);
        }
      }
    }

    mkdirSync(ariad, { recursive: true });
    ensureAriadGitignore(ariad);
    const createdAt = this.now().toISOString();
    writeJson(manifest, {
      id: base.id,
      name: String(name),
      goal,
      mode: effectiveMode,
      sourcePath: adoptedWorkspace,
      adopted: Boolean(adoptedWorkspace),
      createdAt,
      workspace,
      stateDb: db,
      desiredState: 'STOPPED',
      executionState: 'IDLE',
      roleModels: normalizeRoleModels(roleModels),
      frontdeskBinding: frontdeskBinding ?? projectAgent ?? null,
    });
    if (adoptedWorkspace) {
      writeJson(base.adoptedRef, { id: base.id, workspace: adoptedWorkspace });
    }
    return this.status(base.id);
  }

  adopt(name, sourcePath) {
    const base = this.paths(name);
    const exists = existsSync(base.manifest) || existsSync(base.legacyManifest) || existsSync(base.adoptedRef);
    if (!exists) {
      if (!sourcePath) throw new Error('sourcePath is required for adoption');
      return this.create(name, {
        mode: 'TAKEOVER',
        sourcePath,
      });
    }

    const current = this.status(base.id);
    if (current.adopted) return current;
    if (current.desiredState !== 'STOPPED') throw new Error('project must be STOPPED before adoption');
    const targetWorkspace = resolve(sourcePath ?? current.sourcePath ?? '');
    if (!targetWorkspace) throw new Error('sourcePath is required for adoption');
    ensureGitRepo(targetWorkspace);

    const oldWorkspace = resolve(current.workspace);
    if (!removableGeneratedWorkspace(oldWorkspace)) {
      throw new Error('cannot adopt: isolated workspace contains product files outside .ariad/.git; reconcile them manually first');
    }

    const targetAriad = join(targetWorkspace, '.ariad');
    const targetManifest = join(targetAriad, 'project.json');
    if (existsSync(targetManifest)) {
      throw new Error(`target repository already contains an Ariad project: ${targetManifest}`);
    }
    mkdirSync(targetAriad, { recursive: true });

    const oldAriad = join(oldWorkspace, '.ariad');
    if (existsSync(oldAriad)) cpSync(oldAriad, targetAriad, { recursive: true, force: false, errorOnExist: true });
    ensureAriadGitignore(targetAriad);

    const next = {
      ...current,
      root: undefined,
      mode: 'TAKEOVER',
      sourcePath: targetWorkspace,
      adopted: true,
      workspace: targetWorkspace,
      stateDb: join(targetAriad, 'state.db'),
    };
    writeJson(targetManifest, next);
    mkdirSync(base.root, { recursive: true });
    writeJson(base.adoptedRef, { id: base.id, workspace: targetWorkspace });

    // After the external durable state is complete, remove the generated workspace
    // so there is only one Ariad state location.
    if (existsSync(oldWorkspace)) rmSync(oldWorkspace, { recursive: true, force: true });
    if (existsSync(base.legacyManifest)) rmSync(base.legacyManifest, { force: true });
    if (existsSync(base.legacyAriad)) rmSync(base.legacyAriad, { recursive: true, force: true });
    return this.status(base.id);
  }

  list() {
    if (!existsSync(this.projectsRoot)) return [];
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const p = this.paths(entry.name);
        return existsSync(p.manifest) || existsSync(p.legacyManifest) || existsSync(p.adoptedRef);
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
      mode: manifest.mode ?? 'NEW',
      sourcePath: manifest.sourcePath ?? null,
      adopted: manifest.adopted ?? p.adopted ?? false,
      frontdeskBinding,
      roleModels: normalizeRoleModels(manifest.roleModels ?? {}),
      executionState: manifest.executionState ?? 'IDLE',
      root: p.root,
    };
  }

  writeManifest(name, patch) {
    const p = this.resolveProjectPaths(name);
    const current = this.status(p.id);
    writeJson(p.manifest, { ...current, root: undefined, ...patch });
    return this.status(p.id);
  }

  setRoleModels(name, roleModels) {
    const current = this.status(name);
    return this.writeManifest(name, {
      roleModels: {
        ...(current.roleModels ?? {}),
        ...normalizeRoleModels(roleModels),
      },
    });
  }

  setDesiredState(name, desiredState) {
    if (!['RUNNING', 'STOPPED'].includes(desiredState)) throw new Error(`invalid desired state: ${desiredState}`);
    return this.writeManifest(name, { desiredState });
  }

  setExecutionState(name, executionState) {
    const allowed = ['IDLE', 'PLANNING', 'RUNNING', 'NEEDS_HUMAN', 'FAILED', 'SUCCEEDED'];
    if (!allowed.includes(executionState)) throw new Error(`invalid execution state: ${executionState}`);
    const current = this.status(name);
    if (current.executionState === executionState) return current;
    return this.writeManifest(name, { executionState });
  }

  bindFrontdesk(name, frontdeskBinding) {
    return this.writeManifest(name, { frontdeskBinding });
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
