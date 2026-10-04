import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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

export function beginPlanningModelMigration({
  store,
  projectId,
  artifactRoot,
  now = () => new Date(),
}) {
  let project = store.getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  const fromVersion = projectPlanningModelVersion(project);
  const toVersion = CURRENT_PLANNING_MODEL_VERSION;
  if (fromVersion > toVersion) {
    throw new Error(`project planning model v${fromVersion} is newer than runtime v${toVersion}`);
  }
  if (projectStorageVersion(project) > CURRENT_STORAGE_VERSION) {
    throw new Error(`project storage v${projectStorageVersion(project)} is newer than runtime v${CURRENT_STORAGE_VERSION}`);
  }
  if (project?.planningModelMigration?.status === 'REBUILDING') {
    return structuredClone(project.planningModelMigration);
  }
  if (fromVersion === toVersion) return null;

  const tasks = store.listTasks(projectId);
  const active = tasks.filter(task => ['WORKING', 'RESULT_READY'].includes(task.state));
  if (active.length > 0) {
    throw new Error(`planning-model migration requires no active role runs; active tasks: ${active.map(task => task.id).join(', ')}`);
  }

  const at = now().toISOString();
  const id = migrationId(fromVersion, toVersion);
  const migrationRoot = join(artifactRoot, 'migrations', `${id}-${at.replace(/[:.]/g, '-')}`);
  mkdirSync(migrationRoot, { recursive: true });

  const snapshot = {
    version: 1,
    migration: { id, fromVersion, toVersion, startedAt: at },
    project: structuredClone(project),
    tasks: structuredClone(tasks),
    planningRequests: structuredClone(store.listPlanningRequests(projectId)),
    incidents: structuredClone(store.listIncidents(projectId)),
    humanDecisions: humanDecisions(tasks),
  };
  const snapshotPath = join(migrationRoot, 'control-plane-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  const plannerRoot = join(artifactRoot, 'planner');
  const legacyPlannerPath = join(migrationRoot, 'planner');
  if (existsSync(plannerRoot)) {
    cpSync(plannerRoot, legacyPlannerPath, { recursive: true });
    rmSync(plannerRoot, { recursive: true, force: true });
  }

  store.resetControlPlaneForPlanningMigration(projectId);

  project = store.getProject(projectId);
  const migration = {
    id,
    status: 'REBUILDING',
    fromVersion,
    toVersion,
    startedAt: at,
    snapshotPath,
    legacyPlannerPath: existsSync(legacyPlannerPath) ? legacyPlannerPath : null,
    strategy: 'reconstruct-and-reconcile',
  };
  project = store.updateProject(projectId, project.version, {
    deliveryEnabled: false,
    storageVersion: CURRENT_STORAGE_VERSION,
    planningModelMigration: migration,
  });

  store.enqueuePlanningRequest({
    id: `${projectId}:version-migration:${fromVersion}-${toVersion}`,
    projectId,
    request: {
      purpose: 'VERSION_MIGRATION',
      fromPlanningModelVersion: fromVersion,
      toPlanningModelVersion: toVersion,
      strategy: 'reconstruct-and-reconcile',
      instruction: [
        'Reconstruct the project under the current planning model from the durable product intent and current workspace.',
        'Treat the legacy control-plane snapshot as evidence, not as authoritative current task state.',
        'Preserve completed implementation in the workspace; do not rewrite working code merely because tasks are being reconstructed.',
        'Create current Feature/Milestone/Interface ownership and canonical tasks, then reconcile existing implementation against those contracts.',
        'Existing implementation that satisfies a new interface should be adopted and freshly verified rather than unnecessarily reimplemented.',
      ].join(' '),
    },
    context: {
      migrationSnapshotPath: snapshotPath,
      legacyPlannerPath: migration.legacyPlannerPath,
      humanDecisions: snapshot.humanDecisions,
    },
  });

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
