import { execFile } from 'node:child_process';

import { detectProjectLanguages, probeLanguageServers } from './code-intelligence/project-capabilities.js';

/**
 * Project-startup plugin slots: the lifecycle surface for optional
 * per-project capabilities - detect, install, maintain.
 *
 * Two slot kinds share one shape:
 * - 'lsp' (tool slots): one per detected language. The slot knows which
 *   server binary the language needs and how to install it. Installing
 *   only ever happens on an explicit operator action, never implicitly
 *   at project creation. `runtimeTier` is honest about consumption:
 *   only Godot's LSP is wired into the runtime today; other languages
 *   run on the rg fallback even when their server is installed, until
 *   their runtime provider lands.
 * - 'feature' (configuration slots): the artist. Its "installation" is
 *   configuration - the project opts in or out at startup, and an
 *   enabled artist is only 'ready' once it has a model.
 */

export const LSP_INSTALL_RECIPES = Object.freeze({
  gdscript: Object.freeze({
    kind: 'bundled',
    hint: 'LSP 由 Godot 引擎提供: 设置 GODOT_BIN 或确保 godot 在 PATH 中, 无需单独安装。',
  }),
  typescript: Object.freeze({
    kind: 'command',
    argv: Object.freeze(['npm', 'install', '-g', 'typescript-language-server', 'typescript']),
    label: 'npm install -g typescript-language-server typescript',
  }),
  javascript: Object.freeze({
    kind: 'command',
    argv: Object.freeze(['npm', 'install', '-g', 'typescript-language-server', 'typescript']),
    label: 'npm install -g typescript-language-server typescript',
  }),
  python: Object.freeze({
    kind: 'command',
    argv: Object.freeze(['python3', '-m', 'pip', 'install', 'pyright']),
    label: 'python3 -m pip install pyright (provides pyright-langserver)',
  }),
  rust: Object.freeze({
    kind: 'command',
    argv: Object.freeze(['rustup', 'component', 'add', 'rust-analyzer']),
    label: 'rustup component add rust-analyzer',
  }),
  go: Object.freeze({
    kind: 'command',
    argv: Object.freeze(['go', 'install', 'golang.org/x/tools/gopls@latest']),
    label: 'go install golang.org/x/tools/gopls@latest (ensure $(go env GOPATH)/bin is on PATH)',
  }),
});

export function artistEnabled(manifest) {
  return manifest?.features?.artist?.enabled !== false;
}

export function inspectProjectSlots({ workspace, manifest }) {
  const languages = detectProjectLanguages(workspace);
  const probes = probeLanguageServers(languages);
  const slots = languages.map(language => {
    const probe = probes[language] ?? { lsp: null, status: 'unsupported', kind: null };
    return {
      slotId: `lsp:${language}`,
      kind: 'lsp',
      language,
      label: `LSP: ${language}`,
      state: probe.status === 'available' ? 'installed' : 'missing',
      server: probe.lsp ?? null,
      runtimeTier: probe.kind === 'godot' ? 'full-lsp' : 'search-fallback',
      install: LSP_INSTALL_RECIPES[language] ?? { kind: 'manual', hint: `no install recipe for ${language}` },
    };
  });
  const enabled = artistEnabled(manifest);
  const artistModel = manifest?.roleModels?.artist ?? null;
  slots.push({
    slotId: 'feature:artist',
    kind: 'feature',
    role: 'artist',
    label: 'Artist (media/assets)',
    enabled,
    state: !enabled ? 'disabled' : (artistModel ? 'ready' : 'unconfigured'),
    modelRef: artistModel,
    install: {
      kind: 'configure',
      hint: 'artist 通过配置模型启用: ariad project set-role-models 或安装级角色默认; 禁用在 create 时用 --features {"artist":{"enabled":false}}',
    },
  });
  return { languages, slots };
}

function runCommand(argv, { execFileImpl = execFile, timeoutMs = 600000 } = {}) {
  return new Promise(resolvePromise => {
    execFileImpl(argv[0], argv.slice(1), { timeout: timeoutMs }, (error, stdout, stderr) => {
      const tail = `${stdout ?? ''}\n${stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
      if (error) resolvePromise({ ok: false, error: String(error.message ?? error), output: tail });
      else resolvePromise({ ok: true, output: tail });
    });
  });
}

/** Install (or reinstall) one slot. Operator-triggered only. */
export async function installProjectSlot({ workspace, manifest }, slotId, options = {}) {
  const { slots } = inspectProjectSlots({ workspace, manifest });
  const slot = slots.find(entry => entry.slotId === slotId);
  if (!slot) {
    return { ok: false, slotId, reason: 'SLOT_NOT_FOUND', hint: `slots here: ${slots.map(s => s.slotId).join(', ')}` };
  }
  if (slot.kind === 'feature') {
    return { ok: false, slotId, reason: 'CONFIGURE_NOT_INSTALL', hint: slot.install.hint };
  }
  if (slot.install.kind === 'bundled') {
    return { ok: false, slotId, reason: 'BUNDLED_WITH_ENGINE', hint: slot.install.hint, state: slot.state };
  }
  if (slot.install.kind !== 'command') {
    return { ok: false, slotId, reason: 'NO_INSTALL_RECIPE', hint: slot.install.hint ?? null };
  }
  const result = await runCommand(slot.install.argv, options);
  const after = inspectProjectSlots({ workspace, manifest }).slots.find(entry => entry.slotId === slotId);
  return {
    ok: result.ok,
    slotId,
    command: slot.install.label,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
    state: after?.state ?? null,
    server: after?.server ?? null,
  };
}
