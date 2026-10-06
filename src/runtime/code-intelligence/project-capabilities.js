import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

import { GodotLspProvider } from './godot-lsp-provider.js';

const LANGUAGE_RULES = Object.freeze([
  { id: 'gdscript', extensions: ['.gd'], manifests: ['project.godot'], lsp: { command: process.env.GODOT_BIN ?? 'godot', alternatives: ['godot4'], kind: 'godot' } },
  { id: 'typescript', extensions: ['.ts', '.tsx'], manifests: ['tsconfig.json'], lsp: { command: 'typescript-language-server', kind: 'generic' } },
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], manifests: ['package.json'], lsp: { command: 'typescript-language-server', kind: 'generic' } },
  { id: 'python', extensions: ['.py'], manifests: ['pyproject.toml', 'requirements.txt', 'setup.py'], lsp: { command: 'pyright-langserver', alternatives: ['pylsp'], kind: 'generic' } },
  { id: 'rust', extensions: ['.rs'], manifests: ['Cargo.toml'], lsp: { command: 'rust-analyzer', kind: 'generic' } },
  { id: 'go', extensions: ['.go'], manifests: ['go.mod'], lsp: { command: 'gopls', kind: 'generic' } },
]);

const SKIP_DIRS = new Set(['.git', '.ariad', 'node_modules', 'dist', 'build', '.venv', 'venv', 'target']);

export function commandAvailable(command) {
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? command + extension : command);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

export function probeRequiredRuntimeDependencies() {
  const dependencies = {
    node: { required: true, available: commandAvailable('node') },
    git: { required: true, available: commandAvailable('git') },
    rg: { required: true, available: commandAvailable('rg') },
  };
  const missing = Object.entries(dependencies)
    .filter(([, value]) => value.required && !value.available)
    .map(([name]) => name);
  return { dependencies, missing, ready: missing.length === 0 };
}

export function requireRuntimeDependencies() {
  const result = probeRequiredRuntimeDependencies();
  if (result.missing.length) {
    throw new Error(`RUNTIME_DEPENDENCY_MISSING: ${result.missing.join(', ')}`);
  }
  return result;
}

export function detectProjectLanguages(workspace, { maxFiles = 5000 } = {}) {
  const found = new Set();
  let visited = 0;

  for (const rule of LANGUAGE_RULES) {
    if (rule.manifests.some(name => existsSync(join(workspace, name)))) found.add(rule.id);
  }

  function walk(dir) {
    if (visited >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const extension = extname(entry.name).toLowerCase();
      for (const rule of LANGUAGE_RULES) {
        if (rule.extensions.includes(extension)) found.add(rule.id);
      }
    }
  }

  walk(workspace);
  return [...found].sort();
}

export function probeLanguageServers(languages) {
  const result = {};
  for (const language of languages) {
    const rule = LANGUAGE_RULES.find(item => item.id === language);
    if (!rule?.lsp) {
      result[language] = { detected: true, lsp: null, status: 'unsupported', fallback: 'rg' };
      continue;
    }
    const candidates = [rule.lsp.command, ...(rule.lsp.alternatives ?? [])];
    const command = candidates.find(commandAvailable) ?? null;
    result[language] = {
      detected: true,
      lsp: command,
      status: command ? 'available' : 'unavailable',
      fallback: 'rg',
      kind: rule.lsp.kind,
    };
  }
  return result;
}

export function inspectProjectCodeCapabilities(workspace) {
  const languages = detectProjectLanguages(workspace);
  return {
    textSearch: { provider: 'rg', required: true, available: commandAvailable('rg') },
    languages: probeLanguageServers(languages),
  };
}

export function createProjectCodeIntelligence(project, capabilities) {
  const gdscript = capabilities?.languages?.gdscript;
  if (!gdscript || gdscript.status !== 'available' || gdscript.kind !== 'godot') {
    return null;
  }
  const lspPort = 6100 + [...String(project.id)].reduce((sum, ch) => (sum + ch.charCodeAt(0)) % 1000, 0);
  return new GodotLspProvider({
    projectPath: project.workspace,
    godotBinary: gdscript.lsp,
    port: lspPort,
    launch: true,
  });
}
