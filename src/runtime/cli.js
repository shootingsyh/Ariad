#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { AriadProjectManager, defaultProjectsRoot } from './project-manager.js';
import { recordRequirementsApproval } from '../v2/project-docs.js';
import { setupPiProviders } from './pi-provider-setup.js';
import { daemonRequest, ensureAriadDaemon, daemonPaths, daemonLiveness } from './daemon.js';
import { ariadBuildId } from './build-id.js';
import { createAriadConfigService, probeLocalEndpoint } from './config-service.js';
import { runConfigWizard } from './config-wizard.js';
import { installProjectSlot } from './plugin-slots.js';
import { attemptIgnition } from './bootstrap.js';
import { runConfigAssistant, ASSISTANT_SYSTEM_PROMPT } from './config-assistant.js';
import { createInterface } from 'node:readline/promises';

function usage() {
  return [
    'Usage:',
    '  ariad setup',
    '  ariad project {start|resume|pause|soft-stop|stop|status|models|issues} <name> [--projects-root <path>]\n  ariad project analyze <name> <instruction> [--projects-root <path>]\n  ariad project approve-requirements <name> [--projects-root <path>]\n  ariad project issue-open <name> <json> [--projects-root <path>]',
    '  ariad project set-role-models <name> <json> [--projects-root <path>]',
    '  ariad project interfaces <name> [--id <interface-id>] [--projects-root <path>]',
    '  ariad daemon {start|status|stop|restart} [--projects-root <path>]',
    '  ariad dashboard {start|stop|status} [--port 18793]',
    '  ariad config local-endpoint <url> [--projects-root <path>]',
    '  ariad config guide   (interactive; ariad setup does the same on a TTY)',
    '  ariad config bootstrap   (find a model that answers, or a structured ignition-failure report)',
    '  ariad config assistant   (interactive: the ignited model guides configuration; every change needs your confirmation)',
    '  ariad config show',
    '  ariad config probe <base-url>',
    '  ariad config set-roles <json>',
    '  ariad config add-provider <json>',
    '  ariad config remove-provider <id>',
    '  ariad project {create|takeover} <name> --goal <text> --role-models <json> [--source-path <dir>] [--features <json>]',
    '  ariad project slots <name>',
    '  ariad project slots-install <name> <slot-id>',
    '  ariad project adopt <name> --source-path <dir> [--role-models <json>]',
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
  let interfaceId = null;
  let providerSpec = null;
  let providerId = null;
  let features = null;
  let slotId = null;
  if (scope === 'project' && action !== 'list') name = arguments_.shift() ?? null;
  if (scope === 'project' && action === 'analyze') analysisInstruction = arguments_.shift() ?? null;
  if (scope === 'project' && action === 'issue-open') {
    if (!arguments_.length) throw new Error('issue-open requires JSON');
    issue = JSON.parse(arguments_.shift());
  }
  if (scope === 'config' && action === 'local-endpoint') endpoint = arguments_.shift() ?? null;
  if (scope === 'config' && action === 'probe') endpoint = arguments_.shift() ?? null;
  if (scope === 'config' && action === 'set-roles') {
    if (!arguments_.length) throw new Error('config set-roles requires JSON');
    roleModels = JSON.parse(arguments_.shift());
  }
  if (scope === 'config' && action === 'add-provider') {
    if (!arguments_.length) throw new Error('config add-provider requires JSON');
    providerSpec = JSON.parse(arguments_.shift());
  }
  if (scope === 'config' && action === 'remove-provider') providerId = arguments_.shift() ?? null;
  if (scope === 'project' && action === 'slots-install') slotId = arguments_.shift() ?? null;
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
    if (rest[i] === '--features') {
      if (!rest[i + 1]) throw new Error('--features requires JSON');
      features = JSON.parse(rest[++i]);
      continue;
    }
    if (rest[i] === '--source-path') {
      if (!rest[i + 1]) throw new Error('--source-path requires a directory');
      sourcePath = resolve(rest[++i]);
      continue;
    }
    if (rest[i] === '--id') {
      if (!rest[i + 1]) throw new Error('--id requires an interface id');
      interfaceId = rest[++i];
      continue;
    }
    if (rest[i] === '--role-models') {
      if (!rest[i + 1]) throw new Error('--role-models requires JSON');
      roleModels = JSON.parse(rest[++i]);
      continue;
    }
    throw new Error(`unknown argument: ${rest[i]}`);
  }
  return { scope, action, name, projectsRoot, roleModels, goal, sourcePath, endpoint, port, analysisInstruction, issue, interfaceId, providerSpec, providerId, features, slotId };
}


function createTerminalIo() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const io = {
    print: line => { process.stdout.write(String(line) + '\n'); },
    async input(prompt, { default: def } = {}) {
      const answer = (await rl.question(def ? `${prompt} [${def}]: ` : `${prompt}: `)).trim();
      return answer || def || '';
    },
    async secret(prompt) {
      process.stdout.write(`${prompt}: `);
      const original = rl._writeToOutput;
      rl._writeToOutput = () => {};
      try {
        return (await rl.question('')).trim();
      } finally {
        rl._writeToOutput = original;
        process.stdout.write('\n');
      }
    },
    async choose(title, options) {
      io.print(title);
      options.forEach((option, index) => io.print(`  ${index + 1}. ${option.label}${option.hint ? ` (${option.hint})` : ''}`));
      for (;;) {
        const answer = await io.input('输入序号');
        const n = Number.parseInt(answer, 10);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
        io.print(`请输入 1-${options.length}`);
      }
    },
    async confirm(prompt, { default: def = false } = {}) {
      const answer = await io.input(`${prompt} (${def ? 'Y/n' : 'y/N'})`);
      if (!answer) return def;
      return /^y(es)?$/i.test(answer);
    },
    close: () => rl.close(),
  };
  return io;
}

function localBaseUrlDefault(root) {
  let value = 'http://127.0.0.1:18080/v1';
  try {
    const paths = daemonPaths(root);
    if (existsSync(paths.config)) {
      const daemonConfig = JSON.parse(readFileSync(paths.config, 'utf8'));
      if (typeof daemonConfig.localModelBaseUrl === 'string') value = daemonConfig.localModelBaseUrl;
    }
  } catch { /* built-in default stands */ }
  // An explicit env override wins over the persisted daemon config.
  return process.env.ARIAD_LLAMACPP_BASE_URL || value;
}

async function runAssistantSession(root) {
  const service = createAriadConfigService();
  const report = await attemptIgnition({
    configService: service,
    localBaseUrl: localBaseUrlDefault(root),
  });
  if (!report.ignited) {
    return {
      ignited: null,
      attempts: report.attempts,
      fallback: report.fallback,
      hint: '点火失败不是死路：按 fallback 的下一步操作，或直接用无模型路径 ariad config guide / dashboard 配置页。',
    };
  }
  const io = createTerminalIo();
  try {
    const result = await runConfigAssistant({
      service,
      io,
      igniterRef: report.ignited.ref,
      complete: prompt => service.chatComplete(report.ignited.ref, ASSISTANT_SYSTEM_PROMPT, prompt),
    });
    return { ignited: report.ignited, ...result };
  } finally {
    io.close();
  }
}

async function runWizardSession(root) {
  const io = createTerminalIo();
  try {
    return await runConfigWizard({
      service: createAriadConfigService(),
      io,
      localBaseUrlDefault: localBaseUrlDefault(root),
    });
  } finally {
    io.close();
  }
}

export async function runAriadRuntimeCli(argv = process.argv.slice(2)) {
  const { scope, action, name, projectsRoot, roleModels, goal, sourcePath, endpoint, port, analysisInstruction, issue, interfaceId, providerSpec, providerId, features, slotId } = parse(argv);
  // Install-level role defaults (ariad config guide / assistant /
  // dashboard) are the create fallback: an operator who configured
  // defaults should not have to repeat them on every create. Explicit
  // --role-models always wins; takeover/adopt keep their own semantics.
  let effectiveRoleModels = roleModels;
  if (scope === 'project' && action === 'create' && effectiveRoleModels == null) {
    const snapshot = await createAriadConfigService().snapshot();
    if (snapshot.roleDefaults) effectiveRoleModels = snapshot.roleDefaults;
  }
  const root = resolve(process.env.ARIAD_PROJECTS_ROOT || projectsRoot || defaultProjectsRoot(homedir()));
  if (scope === 'daemon') {
    if (action === 'start') {
      const paths = await ensureAriadDaemon(root);
      return { running: true, ...paths };
    }
    if (action === 'status') {
      const localBuildId = ariadBuildId();
      try {
        const ping = await daemonRequest(root, { action: 'ping' }, { timeoutMs: 2000 });
        return { ...ping, localBuildId, stale: ping.buildId !== localBuildId };
      } catch {
        const liveness = daemonLiveness(root);
        return { running: false, pid: liveness.pid, pidAlive: liveness.pidAlive, heartbeatAgeMs: liveness.heartbeatAgeMs, localBuildId };
      }
    }
    if (action === 'stop') return daemonRequest(root, { action: 'daemon_shutdown' });
    if (action === 'restart') {
      try { await daemonRequest(root, { action: 'daemon_shutdown' }, { timeoutMs: 5000 }); } catch {}
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { await daemonRequest(root, { action: 'ping' }, { timeoutMs: 400 }); } catch { break; }
        await new Promise(done => setTimeout(done, 150));
      }
      const paths = await ensureAriadDaemon(root);
      const ping = await daemonRequest(root, { action: 'ping' });
      return { restarted: true, ...paths, ...ping };
    }
    throw new Error(usage());
  }
  if (scope === 'dashboard') {
    if (!['start', 'stop', 'status'].includes(action)) throw new Error(usage());
    if (action === 'start') await ensureAriadDaemon(root);
    return daemonRequest(root, { action: 'dashboard_' + action, ...(port != null ? { port } : {}) });
  }
  if (scope === 'config' && action === 'assistant') {
    if (!process.stdin.isTTY) {
      throw new Error('config assistant 需要交互式终端；非交互请用 ariad config guide 之外的命令式配置（show / set-roles / add-provider）或先跑 ariad config bootstrap 看点火状态');
    }
    return runAssistantSession(root);
  }
  if (scope === 'config' && action === 'guide') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('config guide 需要交互式终端；非交互请用 ariad config show / set-roles / add-provider');
    }
    return runWizardSession(root);
  }
  if (scope === 'setup' && process.stdin.isTTY && process.stdout.isTTY) {
    return runWizardSession(root);
  }
  if (scope === 'config' && action === 'show') {
    const service = createAriadConfigService();
    const snapshot = await service.snapshot();
    const roleValidation = snapshot.roleDefaults
      ? await service.validateRoleModels(snapshot.roleDefaults)
      : null;
    return { config: snapshot, roleValidation };
  }
  if (scope === 'config' && action === 'bootstrap') {
    return attemptIgnition({
      configService: createAriadConfigService(),
      localBaseUrl: localBaseUrlDefault(root),
    });
  }
  if (scope === 'config' && action === 'probe') {
    if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error('config probe requires an HTTP(S) base URL');
    return probeLocalEndpoint(endpoint);
  }
  if (scope === 'config' && action === 'set-roles') {
    const service = createAriadConfigService();
    const saved = service.setRoleDefaults(roleModels);
    const validation = await service.validateRoleModels(saved);
    return { saved: true, roleModels: saved, validation };
  }
  if (scope === 'config' && action === 'add-provider') {
    if (!providerSpec?.id) throw new Error('config add-provider requires JSON with an id');
    return createAriadConfigService().upsertCustomProvider(providerSpec.id, providerSpec);
  }
  if (scope === 'config' && action === 'remove-provider') {
    if (!providerId) throw new Error('config remove-provider requires a provider id');
    return createAriadConfigService().removeCustomProvider(providerId);
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
  if (scope === 'project' && ['create', 'takeover', 'adopt'].includes(action) && effectiveRoleModels != null) {
    // Fail fast at the operator surface: resolve every supplied ref
    // against Pi before the project exists. Refs under providers Pi does
    // not know at all pass through unjudged (session extensions may
    // register them later); a known provider with a wrong model is a
    // typo and stops the create here.
    const config = createAriadConfigService();
    const validation = await config.validateRoleModels(effectiveRoleModels);
    const failures = [];
    for (const [role, result] of Object.entries(validation.roles)) {
      if (!result.ok && await config.providerKnown(result.provider)) {
        failures.push(`${role}: ${effectiveRoleModels[role]} (${result.reason ?? 'unresolvable'})`);
      }
    }
    if (failures.length) {
      throw new Error(`ROLE_MODEL_VALIDATION_FAILED: ${failures.join('; ')} - fix the model refs (ariad config guide) and retry; project was not created`);
    }
  }
  if (scope === 'project' && ['start', 'resume', 'pause', 'soft-stop', 'stop', 'status', 'models', 'interfaces', 'set-role-models', 'list', 'create', 'takeover', 'adopt', 'issue-open', 'issues'].includes(action)) {
    if (action !== 'list' && !name) throw new Error('project name required');
    if (['start', 'resume', 'pause', 'soft-stop', 'stop', 'set-role-models', 'set-ux-review', 'create', 'takeover', 'adopt', 'issue-open'].includes(action)) await ensureAriadDaemon(root);
    const actualAction = action === 'set-ux-review' ? 'set_ux_review' : action === 'set-role-models' ? 'set_role_models' : action === 'soft-stop' ? 'soft_stop' : action === 'issue-open' ? 'open_issue' : action === 'issues' ? 'list_issues' : action;
    return daemonRequest(root, {
      action: actualAction,
      name,
      auditSource: 'cli',
      requestId: `${process.pid}-${Date.now()}`,
      ...(effectiveRoleModels != null ? { roleModels: effectiveRoleModels } : {}),
      ...(features != null ? { features } : {}),
      ...(action === 'set-ux-review' ? { uxReview: { enabled: goal === 'true' } } : {}),
      ...(goal != null ? { goal } : {}),
      ...(sourcePath != null ? { sourcePath } : {}),
      ...(issue != null ? { issue } : {}),
      ...(interfaceId != null ? { interfaceId } : {}),
    });
  }
  return runAriadCli(argv);
}

export function runAriadCli(argv = process.argv.slice(2)) {
  const { scope, action, name, projectsRoot, slotId } = parse(argv);

  if (scope === 'setup') {
    return {
      action: 'setup',
      ...setupPiProviders(),
    };
  }

  if (scope !== 'project' || !name || !['status', 'slots', 'slots-install', 'approve-requirements'].includes(action)) {
    throw new Error(usage());
  }

  const manager = new AriadProjectManager({ projectsRoot });

  if (action === 'slots') {
    return { action, ...manager.projectSlots(name) };
  }

  if (action === 'slots-install') {
    if (!slotId) throw new Error('slots-install requires a slot id (see: ariad project slots <name>)');
    const project = manager.status(name);
    return installProjectSlot({ workspace: project.workspace, manifest: project }, slotId)
      .then(result => ({ action, project: name, ...result }));
  }

  if (action === 'approve-requirements') {
    if (!name) throw new Error('approve-requirements requires a project name');
    const paths = manager.resolveProjectPaths(name);
    const approval = recordRequirementsApproval(paths.workspace, { approvedBy: 'human-cli' });
    return { action, project: name, requirements: approval };
  }

  const project = manager.status(name);

  if (action === 'status') {
    return { action, project };
  }

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
