#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { AriadProjectManager, defaultProjectsRoot } from './project-manager.js';
import { setupPiProviders } from './pi-provider-setup.js';
import { migratePlanningModelDatabase } from '../v2/version-migration.js';
import { daemonRequest, ensureAriadDaemon, daemonPaths } from './daemon.js';

function usage() {
  return [
    'Usage:',
    '  ariad setup',
    '  ariad project {start|resume|pause|soft-stop|stop|status|models|issues} <name> [--projects-root <path>]\n  ariad project analyze <name> <instruction> [--projects-root <path>]\n  ariad project issue-open <name> <json> [--projects-root <path>]',
    '  ariad project set-role-models <name> <json> [--projects-root <path>]',
    '  ariad daemon {start|status|stop} [--projects-root <path>]',
    '  ariad dashboard {start|stop|status} [--port 18793]',
    '  ariad config local-endpoint <url> [--projects-root <path>]',
    '  ariad project {create|takeover} <name> --goal <text> --role-models <json> [--source-path <dir>]',
    '  ariad project adopt <name> --source-path <dir> [--role-models <json>]',
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

  const [scope, action, ...arguments_] = argv;
  let name = null;
  let analysisInstruction = null;
  let roleModels = null;
  let goal = null;
  let sourcePath = null;
  let endpoint = null;
  let port = null;
  let issue = null;
  if (scope === 'project' && action !== 'list') name = arguments_.shift() ?? null;
  if (scope === 'project' && action === 'analyze') analysisInstruction = arguments_.shift() ?? null;
  if (scope === 'project' && action === 'issue-open') {
    if (!arguments_.length) throw new Error('issue-open requires JSON');
    issue = JSON.parse(arguments_.shift());
  }
  if (scope === 'config' && action === 'local-endpoint') endpoint = arguments_.shift() ?? null;
  if (scope === 'project' && action === 'set-role-models') {
    if (!arguments_.length) throw new Error('set-role-models requires JSON');
    roleModels = JSON.parse(arguments_.shift());
  }
  const rest = arguments_;
  let projectsRoot = defaultProjectsRoot(homedir());
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--projects-root') {
      if (!rest[i + 1]) throw new Error('--projects-root requires a path');
      projectsRoot = resolve(rest[++i]);
      continue;
    }
    if (rest[i] === '--port') {
      if (!rest[i + 1]) throw new Error('--port requires a number');
      port = Number(rest[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid --port');
      continue;
    }
    if (rest[i] === '--goal') {
      if (!rest[i + 1]) throw new Error('--goal requires text');
      goal = rest[++i];
      continue;
    }
    if (rest[i] === '--source-path') {
      if (!rest[i + 1]) throw new Error('--source-path requires a directory');
      sourcePath = resolve(rest[++i]);
      continue;
    }
    if (rest[i] === '--role-models') {
      if (!rest[i + 1]) throw new Error('--role-models requires JSON');
      roleModels = JSON.parse(rest[++i]);
      continue;
    }
    throw new Error(`unknown argument: ${rest[i]}`);
  }
  return { scope, action, name, projectsRoot, roleModels, goal, sourcePath, endpoint, port, analysisInstruction, issue };
}


export async function runAriadRuntimeCli(argv = process.argv.slice(2)) {
  const { scope, action, name, projectsRoot, roleModels, goal, sourcePath, endpoint, port, analysisInstruction, issue } = parse(argv);
  const root = resolve(process.env.ARIAD_PROJECTS_ROOT || projectsRoot || defaultProjectsRoot(homedir()));
  if (scope === 'daemon') {
    if (action === 'start') {
      const paths = await ensureAriadDaemon(root);
      return { running: true, ...paths };
    }
    if (action === 'status') return daemonRequest(root, { action: 'ping' });
    if (action === 'stop') return daemonRequest(root, { action: 'daemon_shutdown' });
    throw new Error(usage());
  }
  if (scope === 'dashboard') {
    if (!['start', 'stop', 'status'].includes(action)) throw new Error(usage());
    if (action === 'start') await ensureAriadDaemon(root);
    return daemonRequest(root, { action: 'dashboard_' + action, ...(port != null ? { port } : {}) });
  }
  if (scope === 'config' && action === 'local-endpoint') {
    if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error('local-endpoint requires an HTTP(S) URL');
    const paths = daemonPaths(root);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.config, JSON.stringify({ localModelBaseUrl: endpoint }, null, 2) + '\n', { mode: 0o600 });
    return { config: paths.config, localModelBaseUrl: endpoint, note: 'Takes effect when the daemon next starts' };
  }
  if (scope === 'project' && action === 'analyze') {
    if (!name || !analysisInstruction?.trim()) throw new Error('analyze requires project name and instruction');
    await ensureAriadDaemon(root);
    const id = 'operator-' + Date.now().toString(36);
    return daemonRequest(root, { action: 'operator_analyze', name, id, instruction: analysisInstruction });
  }
  if (scope === 'project' && ['start', 'resume', 'pause', 'soft-stop', 'stop', 'status', 'models', 'set-role-models', 'list', 'create', 'takeover', 'adopt', 'issue-open', 'issues'].includes(action)) {
    if (action !== 'list' && !name) throw new Error('project name required');
    if (['start', 'resume', 'pause', 'soft-stop', 'stop', 'set-role-models', 'create', 'takeover', 'adopt', 'issue-open'].includes(action)) await ensureAriadDaemon(root);
    const actualAction = action === 'set-role-models' ? 'set_role_models' : action === 'soft-stop' ? 'soft_stop' : action === 'issue-open' ? 'open_issue' : action === 'issues' ? 'list_issues' : action;
    return daemonRequest(root, {
      action: actualAction,
      name,
      ...(roleModels != null ? { roleModels } : {}),
      ...(goal != null ? { goal } : {}),
      ...(sourcePath != null ? { sourcePath } : {}),
      ...(issue != null ? { issue } : {}),
    });
  }
  return runAriadCli(argv);
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
    runAriadRuntimeCli().then(result => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }).catch(error => {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
