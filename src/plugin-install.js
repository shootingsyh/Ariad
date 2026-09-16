export function planPluginInstall(input) {
  if (!input?.host || !input?.installDir) throw new Error('host and installDir are required');
  return {
    kind: 'PLUGIN_INSTALL',
    steps: [
      { kind: 'validate_host' },
      { kind: 'install_plugin' },
      { kind: 'register_service' },
      { kind: 'health_check' },
    ]
  };
}
