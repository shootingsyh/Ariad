import legacyPlugin from './legacy-index.js';
import { createAgentSessionSubagentFacade } from './agent-session-subagent-facade.js';

// Experiment branch: keep the entire Ariad control plane unchanged, but replace
// the legacy plugin's subagent execution primitive with normal first-class
// OpenClaw agent sessions. This intentionally requires no Ariad DB migration.
const originalSetup = (legacyPlugin as any).setup;
if (typeof originalSetup !== 'function') throw new Error('Ariad legacy plugin setup is unavailable');

(legacyPlugin as any).setup = function setupAgentSessionExperiment(api: any) {
  const enabled = process.env.ARIAD_EXECUTION_MODE === 'agent-session';
  if (!enabled) return originalSetup.call(this, api);

  const agentId = process.env.ARIAD_OPENCLAW_AGENT_ID || 'main';
  const facade = createAgentSessionSubagentFacade(api, { agentId, pluginId: 'ariad' });
  const runtime = new Proxy(api.runtime, {
    get(target, property, receiver) {
      if (property === 'subagent') return facade;
      return Reflect.get(target, property, receiver);
    },
  });
  const wrappedApi = new Proxy(api, {
    get(target, property, receiver) {
      if (property === 'runtime') return runtime;
      return Reflect.get(target, property, receiver);
    },
  });
  api.logger?.info?.(`Ariad execution mode: agent-session (host agent ${agentId})`);
  return originalSetup.call(this, wrappedApi);
};

export default legacyPlugin;
