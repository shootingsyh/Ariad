import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { SQLiteV2Store } from './sqlite-store.js';
import {
  CURRENT_PLANNING_MODEL_VERSION,
  CURRENT_STORAGE_VERSION,
  projectPlanningModelVersion,
  projectStorageVersion,
} from './schema-version.js';

function migrationId(fromVersion, toVersion) {
  return `planning-v${fromVersion}-to-v${toVersion}`;
}

function humanDecisions(tasks) {
  const decisions = [];
  for (const task of tasks) {
    for (const entry of task.history ?? []) {
      if (entry?.type !== 'HUMAN_DECISION') continue;
      decisions.push({
        taskId: task.id,
        decision: entry.decision ?? null,
        at: entry.at ?? null,
      });
    }
  }
  return decisions;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function directoryDigest(root) {
  if (!root || !existsSync(root)) return null;
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  const hash = createHash('sha256');
  const entries = files.map(path => {
    const rel = relative(root, path);
    const digest = sha256File(path);
    hash.update(rel).update('\0').update(digest).update('\n');
    return { path: rel, sha256: digest };
  });
  return { sha256: hash.digest('hex'), entries };
}

function jsonIds(dir) {
  if (!dir || !existsSync(dir)) return [];
  const ids = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    try {
      const value = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (value?.id) ids.push(String(value.id));
    } catch {}
  }
  return [...new Set(ids)].sort();
}

export function buildPlanningArtifactBundleManifest({
  project,
  snapshotPath,
  legacyDatabasePath,
  legacyPlannerPath,
  legacyRevisionRoot,
  createdAt,
}) {
  const plannerLogicalIds = jsonIds(legacyPlannerPath ? join(legacyPlannerPath, 'logical') : null);
  const plannerMilestoneIds = jsonIds(legacyPlannerPath ? join(legacyPlannerPath, 'milestones') : null);
  const revisionPlanner = legacyRevisionRoot ? join(legacyRevisionRoot, 'planner') : null;
  const revisionLogicalIds = jsonIds(revisionPlanner ? join(revisionPlanner, 'logical') : null);
  const revisionMilestoneIds = jsonIds(revisionPlanner ? join(revisionPlanner, 'milestones') : null);
  const projectLogicalIds = [...new Set((project.logicalNodes ?? []).map(node => String(node.id)).filter(Boolean))].sort();
  const projectMilestoneIds = [...new Set((project.milestones ?? []).map(node => String(node.id)).filter(Boolean))].sort();

  const tuple = {
    projectId: project.id,
    dbVersion: project.version ?? null,
    projectVersion: project.projectVersion ?? null,
    activeVersion: project.activeVersion ?? null,
    deliveryPlanVersion: project.deliveryPlanVersion ?? null,
    planningModelVersion: projectPlanningModelVersion(project),
    storageVersion: projectStorageVersion(project),
  };

  return {
    version: 1,
    bundleId: `${project.id}:pv${tuple.projectVersion ?? 'na'}:av${tuple.activeVersion ?? 'na'}:dp${tuple.deliveryPlanVersion ?? 'na'}:db${tuple.dbVersion ?? 'na'}`,
    createdAt,
    tuple,
    sets: {
      projectLogicalIds,
      projectMilestoneIds,
      plannerLogicalIds,
      plannerMilestoneIds,
      revisionLogicalIds,
      revisionMilestoneIds,
    },
    alignment: {
      projectVsPlannerLogical: projectLogicalIds.length === 0 || JSON.stringify(projectLogicalIds) === JSON.stringify(plannerLogicalIds),
      projectVsPlannerMilestones: projectMilestoneIds.length === 0 || JSON.stringify(projectMilestoneIds) === JSON.stringify(plannerMilestoneIds),
      plannerVsRevisionLogical: JSON.stringify(plannerLogicalIds) === JSON.stringify(revisionLogicalIds),
      plannerVsRevisionMilestones: JSON.stringify(plannerMilestoneIds) === JSON.stringify(revisionMilestoneIds),
    },
    artifacts: {
      controlPlaneSnapshot: snapshotPath ? { path: snapshotPath, sha256: sha256File(snapshotPath) } : null,
      stateDb: legacyDatabasePath ? { path: legacyDatabasePath, sha256: sha256File(legacyDatabasePath) } : null,
      planner: legacyPlannerPath ? { path: legacyPlannerPath, ...directoryDigest(legacyPlannerPath) } : null,
      revisionSource: legacyRevisionRoot ? { path: legacyRevisionRoot, ...directoryDigest(legacyRevisionRoot) } : null,
    },
  };
}

export function validatePlanningArtifactBundleManifest(manifest) {
  if (!manifest || manifest.version !== 1) throw new Error('invalid planning artifact bundle manifest');
  const checks = [];
  const fileArtifact = manifest.artifacts?.stateDb;
  if (!fileArtifact?.path || !existsSync(fileArtifact.path)) throw new Error('artifact bundle missing state DB');
  checks.push({ name: 'stateDb', ok: sha256File(fileArtifact.path) === fileArtifact.sha256 });

  const snapshot = manifest.artifacts?.controlPlaneSnapshot;
  if (snapshot?.path) {
    checks.push({ name: 'controlPlaneSnapshot', ok: existsSync(snapshot.path) && sha256File(snapshot.path) === snapshot.sha256 });
  }
  for (const [name, artifact] of [['planner', manifest.artifacts?.planner], ['revisionSource', manifest.artifacts?.revisionSource]]) {
    if (!artifact?.path) continue;
    const digest = directoryDigest(artifact.path);
    checks.push({ name, ok: Boolean(digest && digest.sha256 === artifact.sha256) });
  }
  const failed = checks.filter(check => !check.ok);
  if (failed.length) throw new Error(`ARTIFACT_BUNDLE_MISMATCH: ${failed.map(check => check.name).join(', ')}`);
  return { ok: true, checks, alignment: manifest.alignment, tuple: manifest.tuple };
}

export function planningModelMigrationStatus(project) {
  const fromVersion = projectPlanningModelVersion(project);
  const toVersion = CURRENT_PLANNING_MODEL_VERSION;
  const active = project?.planningModelMigration ?? null;
  return {
    required: fromVersion < toVersion && active?.status !== 'REBUILDING',
    fromVersion,
    toVersion,
    active,
  };
}

export function migratePlanningModelDatabase({
  stateDb,
  projectId,
  artifactRoot,
  now = () => new Date(),
}) {
  const oldStore = new SQLiteV2Store(stateDb);
  let project;
  let snapshot;
  try {
    project = oldStore.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);

    const fromVersion = projectPlanningModelVersion(project);
    const toVersion = CURRENT_PLANNING_MODEL_VERSION;
    if (fromVersion > toVersion) {
      throw new Error(`project planning model v${fromVersion} is newer than runtime v${toVersion}`);
    }
    if (projectStorageVersion(project) > CURRENT_STORAGE_VERSION) {
      throw new Error(`project storage v${projectStorageVersion(project)} is newer than runtime v${CURRENT_STORAGE_VERSION}`);
    }
    if (fromVersion === toVersion) return null;

    const tasks = oldStore.listTasks(projectId);
    const active = tasks.filter(task => ['WORKING', 'RESULT_READY'].includes(task.state));
    if (active.length > 0) {
      throw new Error(`planning-model migration requires no active role runs; active tasks: ${active.map(task => task.id).join(', ')}`);
    }

    snapshot = {
      version: 1,
      migration: {
        id: migrationId(fromVersion, toVersion),
        fromVersion,
        toVersion,
      },
      project: structuredClone(project),
      tasks: structuredClone(tasks),
      planningRequests: structuredClone(oldStore.listPlanningRequests(projectId)),
      incidents: structuredClone(oldStore.listIncidents(projectId)),
      humanDecisions: humanDecisions(tasks),
    };
    oldStore.checkpoint();
  } finally {
    oldStore.close();
  }

  const at = now().toISOString();
  const fromVersion = projectPlanningModelVersion(project);
  const toVersion = CURRENT_PLANNING_MODEL_VERSION;
  const id = migrationId(fromVersion, toVersion);
  const migrationRoot = join(artifactRoot, 'migrations', `${id}-${at.replace(/[:.]/g, '-')}`);
  mkdirSync(migrationRoot, { recursive: true });

  snapshot.migration.startedAt = at;
  const snapshotPath = join(migrationRoot, 'control-plane-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  const plannerRoot = join(artifactRoot, 'planner');
  const legacyPlannerPath = join(migrationRoot, 'planner');
  const legacyRevisionRoot = join(migrationRoot, 'revision-source');
  const revisionWorkRoot = join(migrationRoot, 'revision-work');
  if (existsSync(plannerRoot)) {
    cpSync(plannerRoot, legacyPlannerPath, { recursive: true });
    mkdirSync(legacyRevisionRoot, { recursive: true });
    mkdirSync(revisionWorkRoot, { recursive: true });
    cpSync(plannerRoot, join(legacyRevisionRoot, 'planner'), { recursive: true });
    cpSync(plannerRoot, join(revisionWorkRoot, 'planner'), { recursive: true });
    rmSync(plannerRoot, { recursive: true, force: true });
  }

  const legacyDbPath = join(migrationRoot, 'state.db');
  mkdirSync(dirname(legacyDbPath), { recursive: true });
  renameSync(stateDb, legacyDbPath);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${stateDb}${suffix}`;
    if (existsSync(sidecar)) {
      renameSync(sidecar, `${legacyDbPath}${suffix}`);
    }
  }

  const bundleManifestPath = join(migrationRoot, 'artifact-bundle.json');
  const bundleManifest = buildPlanningArtifactBundleManifest({
    project,
    snapshotPath,
    legacyDatabasePath: legacyDbPath,
    legacyPlannerPath: existsSync(legacyPlannerPath) ? legacyPlannerPath : null,
    legacyRevisionRoot: existsSync(join(legacyRevisionRoot, 'planner')) ? legacyRevisionRoot : null,
    createdAt: at,
  });
  writeFileSync(bundleManifestPath, JSON.stringify(bundleManifest, null, 2) + '\n', 'utf8');

  const migration = {
    id,
    status: 'REBUILDING',
    fromVersion,
    toVersion,
    startedAt: at,
    snapshotPath,
    legacyDatabasePath: legacyDbPath,
    legacyPlannerPath: existsSync(legacyPlannerPath) ? legacyPlannerPath : null,
    legacyRevisionRoot: existsSync(join(legacyRevisionRoot, 'planner')) ? legacyRevisionRoot : null,
    revisionWorkRoot: existsSync(join(revisionWorkRoot, 'planner')) ? revisionWorkRoot : null,
    artifactBundleManifestPath: bundleManifestPath,
    artifactBundleId: bundleManifest.bundleId,
    strategy: 'reconstruct-and-reconcile',
  };

  const freshStore = new SQLiteV2Store(stateDb);
  try {
    freshStore.createProject({
      id: project.id,
      spec: project.spec ?? null,
      mode: project.mode ?? 'NEW',
      sourcePath: project.sourcePath ?? null,
      workspace: project.workspace ?? null,
      pmBinding: project.pmBinding ?? `pm:${project.id}`,
      deliveryEnabled: false,
      takeoverReviewRequired: false,
      projectVersion: project.projectVersion ?? 0,
      activeVersion: project.activeVersion ?? 1,
      versionHistory: structuredClone(project.versionHistory ?? []),
      storageVersion: CURRENT_STORAGE_VERSION,
      planningModelVersion: fromVersion,
      planningModelMigration: migration,
    });

    freshStore.enqueuePlanningRequest({
      id: `${projectId}:version-migration:${fromVersion}-${toVersion}`,
      projectId,
      request: {
        purpose: 'VERSION_MIGRATION',
        fromPlanningModelVersion: fromVersion,
        toPlanningModelVersion: toVersion,
        strategy: 'reconstruct-and-reconcile',
        instruction: [
          'Reconstruct the project under the current planning model from durable product intent and the current workspace.',
          'Treat the legacy database and planner snapshot as evidence, not authoritative current control state.',
          'The legacy revision-source snapshot is immutable: write all revision decisions only to revisionWorkRoot.',
          'Preserve completed implementation in the workspace; do not rewrite working code merely because tasks are reconstructed.',
          'Create current Feature/Milestone/Interface ownership and canonical tasks, then reconcile existing implementation against those contracts.',
          'Existing implementation that satisfies a new interface should be adopted and freshly verified rather than unnecessarily reimplemented.',
        ].join(' '),
      },
      context: {
        migrationSnapshotPath: snapshotPath,
        legacyDatabasePath: legacyDbPath,
        legacyPlannerPath: migration.legacyPlannerPath,
        legacyRevisionRoot: migration.legacyRevisionRoot,
        revisionWorkRoot: migration.revisionWorkRoot,
        artifactBundleManifestPath: bundleManifestPath,
        artifactBundleId: bundleManifest.bundleId,
        humanDecisions: snapshot.humanDecisions,
      },
    });
  } finally {
    freshStore.close();
  }

  return structuredClone(migration);
}

export function completePlanningModelMigration(store, projectId) {
  let project = store.getProject(projectId);
  const migration = project?.planningModelMigration;
  if (!migration || migration.status !== 'REBUILDING') return project;
  const at = new Date().toISOString();
  project = store.updateProject(projectId, project.version, {
    planningModelVersion: migration.toVersion,
    storageVersion: CURRENT_STORAGE_VERSION,
    planningModelMigration: {
      ...migration,
      status: 'COMPLETED',
      completedAt: at,
    },
  });
  return project;
}

export function restorePlanningArtifactBundle({
  stateDb,
  artifactRoot,
  bundleManifestPath,
  abandonedRoot = join(artifactRoot, 'abandoned-migrations'),
  now = () => new Date(),
}) {
  const manifest = JSON.parse(readFileSync(bundleManifestPath, 'utf8'));
  validatePlanningArtifactBundleManifest(manifest);

  const at = now().toISOString().replace(/[:.]/g, '-');
  const abandoned = join(abandonedRoot, `restore-${at}`);
  mkdirSync(abandoned, { recursive: true });

  if (existsSync(stateDb)) {
    cpSync(stateDb, join(abandoned, 'state.db'));
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${stateDb}${suffix}`;
    if (existsSync(sidecar)) cpSync(sidecar, join(abandoned, `state.db${suffix}`));
  }

  const livePlanner = join(artifactRoot, 'planner');
  if (existsSync(livePlanner)) cpSync(livePlanner, join(abandoned, 'planner'), { recursive: true });

  rmSync(stateDb, { force: true });
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${stateDb}${suffix}`, { force: true });
  rmSync(livePlanner, { recursive: true, force: true });

  cpSync(manifest.artifacts.stateDb.path, stateDb);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const source = `${manifest.artifacts.stateDb.path}${suffix}`;
    if (existsSync(source)) cpSync(source, `${stateDb}${suffix}`);
  }
  if (manifest.artifacts.planner?.path) {
    cpSync(manifest.artifacts.planner.path, livePlanner, { recursive: true });
  }

  const restored = new SQLiteV2Store(stateDb);
  try {
    const project = restored.getProject(manifest.tuple.projectId);
    if (!project) throw new Error(`restored bundle missing project: ${manifest.tuple.projectId}`);
    const actualTuple = {
      projectId: project.id,
      dbVersion: project.version ?? null,
      projectVersion: project.projectVersion ?? null,
      activeVersion: project.activeVersion ?? null,
      deliveryPlanVersion: project.deliveryPlanVersion ?? null,
      planningModelVersion: projectPlanningModelVersion(project),
      storageVersion: projectStorageVersion(project),
    };
    if (JSON.stringify(actualTuple) !== JSON.stringify(manifest.tuple)) {
      throw new Error(`ARTIFACT_BUNDLE_RESTORE_MISMATCH: expected ${JSON.stringify(manifest.tuple)}, got ${JSON.stringify(actualTuple)}`);
    }
  } finally {
    restored.close();
  }

  return {
    restoredBundleId: manifest.bundleId,
    tuple: structuredClone(manifest.tuple),
    abandonedPath: abandoned,
  };
}
