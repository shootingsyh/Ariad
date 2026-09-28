import { existsSync, readFileSync } from 'node:fs';

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export function detectExecutionCapabilities({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  read = safeRead,
} = {}) {
  const capabilities = new Set();
  if (platform === 'linux') capabilities.add('linux.native');
  if (platform === 'win32') {
    capabilities.add('windows.native');
    capabilities.add('cmd');
    capabilities.add('powershell');
  }

  const procVersion = platform === 'linux' ? read('/proc/version') : '';
  const isWsl = platform === 'linux'
    && (Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(procVersion));
  if (isWsl) capabilities.add('wsl');

  const windowsCmd = '/mnt/c/Windows/System32/cmd.exe';
  const windowsPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (isWsl && exists(windowsCmd)) {
    capabilities.add('windows.host-via-wsl');
    capabilities.add('cmd');
  }
  if (isWsl && exists(windowsPowerShell)) capabilities.add('powershell');

  if (exists('/dev/nvidia0') || exists('/dev/dxg')) capabilities.add('gpu');

  return [...capabilities].sort();
}
