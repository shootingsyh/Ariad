import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
  if (existsSync(plannerRoot)) {
    cpSync(plannerRoot, legacyPlannerPath, { recursive: true });
    mkdirSync(legacyRevisionRoot, { recursive: true });
    cpSync(plannerRoot, join(legacyRevisionRoot, 'planner'), { recursive: true });
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
