#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { AriadProjectManager, defaultProjectsRoot } from './project-manager.js';
import { setupPiProviders } from './pi-provider-setup.js';
import { migratePlanningModelDatabase } from '../v2/version-migration.js';

function usage() {
  return [
    'Usage:',
    '  ariad setup',
    '  ariad project migrate <name> [--projects-root <path>]',
    '  ariad project status <name> [--projects-root <path>]',
    '',
    'Setup prepares/checks global Pi provider authentication without printing credentials.',
    'Migration requires the project to be STOPPED. It archives the entire old state.db and planner artifacts before creating a fresh control plane.',
  ].join('\n');
}

function parse(argv) {
  if (argv[0] === 'setup') {
    if (argv.length !== 1) throw new Error(usage());
    return { scope: 'setup', action: null, name: null, projectsRoot: null };
  }

  const [scope, action, name, ...rest] = argv;
  let projectsRoot = defaultProjectsRoot(homedir());
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--projects-root') {
      if (!rest[i + 1]) throw new Error('--projects-root requires a path');
      projectsRoot = resolve(rest[++i]);
      continue;
    }
    throw new Error(`unknown argument: ${rest[i]}`);
  }
  return { scope, action, name, projectsRoot };
}

export function runAriadCli(argv = process.argv.slice(2)) {
  const { scope, action, name, projectsRoot } = parse(argv);

  if (scope === 'setup') {
    return {
      action: 'setup',
      ...setupPiProviders(),
    };
  }

  if (scope !== 'project' || !name || !['migrate', 'status'].includes(action)) {
    throw new Error(usage());
  }

  const manager = new AriadProjectManager({ projectsRoot });
  const project = manager.status(name);

  if (action === 'status') {
    return { action, project };
  }

  if (project.desiredState !== 'STOPPED') {
    throw new Error(
      `project ${project.id} must be STOPPED before planning-model migration; current desiredState=${project.desiredState}`,
    );
  }

  const migration = migratePlanningModelDatabase({
    stateDb: project.stateDb,
    projectId: project.id,
    artifactRoot: join(project.workspace, '.ariad', 'artifacts'),
  });

  if (!migration) {
    return {
      action,
      projectId: project.id,
      migrated: false,
      reason: 'planning model already current',
    };
  }

  manager.setExecutionState(project.id, 'IDLE');
  return {
    action,
    projectId: project.id,
    migrated: true,
    migration,
    next: `start/resume project ${project.id} so Ariad can rebuild and reconcile the new control plane`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runAriadCli();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
